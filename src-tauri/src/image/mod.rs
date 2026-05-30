//! Two-stage image pipeline (§7).
//!
//! Stage 1 — **Prompt expansion.** A local Ollama daemon running `qwen3-vl`
//! rewrites the user's raw idea into a rich diffusion prompt and classifies it as
//! `typography_heavy` (legible text/lettering is explicitly wanted) or `standard`.
//!
//! Stage 2 — **Smart routing.**
//!   • `typography_heavy` → the **Ideogram** API (superior glyph rendering). The
//!     key is unsealed from the BYOK DB by the §5 crypto layer **in the backend**
//!     and handed in as plaintext — it never crosses IPC to the webview.
//!   • `standard`         → local **FLUX.1 [schnell]** via a ComfyUI server (:8188).
//!
//! DEV RULE (§7): the developer may have none of these heavy local models running.
//! EVERY external hop (`reqwest`) catches connection errors and degrades to a mock
//! expansion / placeholder image, so `generate()` **always returns a value** — the
//! UI can exercise the full two-stage choreography with nothing installed. A
//! `mock` flag + human-readable `note` record what degraded.

#![allow(dead_code)]

use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

// ─── Endpoints ──────────────────────────────────────────────────────────────

/// Local Ollama generate endpoint (Stage 1 prompt expansion).
const OLLAMA_URL: &str = "http://127.0.0.1:11434/api/generate";
const OLLAMA_MODEL: &str = "qwen3-vl";
/// Local ComfyUI host serving FLUX.1-[schnell]: POST a workflow to `/prompt`,
/// poll `/history/<id>`, then GET the rendered bytes from `/view` (Stage 2 std).
const COMFY_HOST: &str = "http://127.0.0.1:8188";
/// Ideogram generate endpoint (Stage 2 typography route). Stable JSON contract
/// (`{ image_request: { … } }` + `Api-Key` header). Swapping to the v3 multipart
/// endpoint is a localised change — the fallback path below is unaffected.
const IDEOGRAM_URL: &str = "https://api.ideogram.ai/generate";

/// Env var name kept symmetric with the proxy layer (unused here — the Ideogram
/// key is passed in-arg — but documents the single source of provider secrets).
const KEY_ENV: &str = "TRENLENS_PROVIDER_KEY";

/// Fail fast when a daemon isn't listening so the IPC call doesn't hang; give the
/// actual render (FLUX poll) a longer overall budget.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(180);

/// System instruction for Stage 1: expand + classify, replying with ONLY JSON.
const EXPANSION_SYSTEM: &str = "You are a prompt engineer for text-to-image diffusion models. \
Given a user's short idea, expand it into a single vivid, richly detailed image-generation \
prompt — name the subject, composition, lighting, lens, palette, and artistic style. Then \
decide whether the image must render legible text/typography (a logo, poster, sign, quote, \
label, UI, headline, or any explicit words). Reply with ONLY a compact JSON object of the \
form {\"expanded_prompt\": string, \"classification\": \"typography_heavy\" | \"standard\"}. \
Use \"typography_heavy\" ONLY when readable text is explicitly part of the request.";

// ─── Public types ───────────────────────────────────────────────────────────

/// The router's verdict for Stage 2.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Classification {
    TypographyHeavy,
    Standard,
}

impl Classification {
    fn as_str(self) -> &'static str {
        match self {
            Classification::TypographyHeavy => "typography_heavy",
            Classification::Standard => "standard",
        }
    }

    fn parse(s: &str) -> Self {
        match s.trim().to_lowercase().as_str() {
            "typography_heavy" | "typography" | "text" => Classification::TypographyHeavy,
            _ => Classification::Standard,
        }
    }
}

/// Final pipeline output, serialised straight to the frontend (`ImageResult` in
/// ipc.ts). `image` is a data-URI (placeholder SVG / FLUX png) or a remote URL
/// (Ideogram). `mock` is true if ANY stage fell back, so the UI can badge it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageResult {
    pub image: String,
    /// "flux" | "ideogram" | "placeholder"
    pub route: String,
    /// "typography_heavy" | "standard"
    pub classification: String,
    pub expanded_prompt: String,
    pub mock: bool,
    pub note: Option<String>,
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

/// Run both stages. `force_route` (from the composer `/image:flux|:ideogram`)
/// overrides the classifier; `ideogram_key` is the already-unsealed plaintext key
/// (or `None`) supplied by the command after a backend-side unseal (§5).
pub async fn generate(
    raw_prompt: &str,
    force_route: Option<&str>,
    ideogram_key: Option<String>,
) -> ImageResult {
    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    // ── Stage 1: expand + classify ──
    let exp = expand_prompt(&client, raw_prompt).await;

    // A forced route trumps the classifier; otherwise trust Stage 1.
    let route = match force_route.map(|r| r.trim().to_lowercase()).as_deref() {
        Some("flux") | Some("standard") => Classification::Standard,
        Some("ideogram") | Some("typography") | Some("typography_heavy") => {
            Classification::TypographyHeavy
        }
        _ => exp.classification,
    };

    let mut notes: Vec<String> = Vec::new();
    if let Some(n) = &exp.note {
        notes.push(n.clone());
    }

    // ── Stage 2: route ──
    let (image, route_label, stage2_mock) = match route {
        Classification::TypographyHeavy => match ideogram_key {
            Some(key) => match route_ideogram(&client, &exp.expanded_prompt, &key).await {
                Ok(url) => (url, "ideogram".to_string(), false),
                Err(e) => {
                    notes.push(format!("Ideogram unavailable ({e}) — showing placeholder."));
                    (placeholder(&route, &exp.expanded_prompt), "placeholder".to_string(), true)
                }
            },
            None => {
                notes.push("No Ideogram key stored — add one in the BYOK panel. Showing placeholder.".into());
                (placeholder(&route, &exp.expanded_prompt), "placeholder".to_string(), true)
            }
        },
        Classification::Standard => match route_flux(&client, &exp.expanded_prompt).await {
            Ok(data_uri) => (data_uri, "flux".to_string(), false),
            Err(e) => {
                notes.push(format!("Local FLUX/ComfyUI unreachable ({e}) — showing placeholder."));
                (placeholder(&route, &exp.expanded_prompt), "placeholder".to_string(), true)
            }
        },
    };

    ImageResult {
        image,
        route: route_label,
        classification: route.as_str().to_string(),
        expanded_prompt: exp.expanded_prompt,
        mock: exp.mock || stage2_mock,
        note: if notes.is_empty() { None } else { Some(notes.join(" ")) },
    }
}

// ─── Stage 1: prompt expansion via Ollama (qwen3-vl) ────────────────────────

struct Expansion {
    expanded_prompt: String,
    classification: Classification,
    mock: bool,
    note: Option<String>,
}

#[derive(Deserialize)]
struct OllamaResponse {
    /// Ollama returns the model's text in `response`; with `format: "json"` that
    /// text is itself a JSON object string we parse a second time.
    response: String,
}

#[derive(Deserialize)]
struct ExpansionJson {
    #[serde(default)]
    expanded_prompt: String,
    #[serde(default)]
    classification: String,
}

async fn expand_prompt(client: &reqwest::Client, raw: &str) -> Expansion {
    let body = json!({
        "model": OLLAMA_MODEL,
        "system": EXPANSION_SYSTEM,
        "prompt": raw,
        "stream": false,
        "format": "json",
    });

    let attempt = async {
        let resp = client
            .post(OLLAMA_URL)
            .json(&body)
            .send()
            .await?
            .error_for_status()?;
        let env: OllamaResponse = resp.json().await?;
        Ok::<String, reqwest::Error>(env.response)
    };

    match attempt.await {
        Ok(raw_json) => match serde_json::from_str::<ExpansionJson>(&raw_json) {
            Ok(p) if !p.expanded_prompt.trim().is_empty() => Expansion {
                expanded_prompt: p.expanded_prompt,
                classification: Classification::parse(&p.classification),
                mock: false,
                note: None,
            },
            _ => mock_expansion(raw, "Ollama replied but the JSON was unparseable — used a heuristic expansion."),
        },
        Err(e) => mock_expansion(
            raw,
            &format!("Ollama (qwen3-vl) unreachable ({}) — used a heuristic expansion.", short_err(&e)),
        ),
    }
}

/// Offline Stage-1 substitute: a light stylistic expansion + keyword classifier,
/// so the pipeline keeps its shape when no vision model is installed.
fn mock_expansion(raw: &str, note: &str) -> Expansion {
    Expansion {
        expanded_prompt: format!(
            "{}, highly detailed, cinematic lighting, balanced composition, sharp focus, 8k",
            raw.trim()
        ),
        classification: classify_heuristic(raw),
        mock: true,
        note: Some(note.to_string()),
    }
}

/// Naive cue-based classifier used only when `qwen3-vl` is unavailable.
fn classify_heuristic(raw: &str) -> Classification {
    const CUES: &[&str] = &[
        "text", "typography", "logo", "poster", "title", "word", "letter", "sign",
        "caption", "label", "quote", "headline", "writing", "font", "slogan",
        "banner", "menu", "infographic", "billboard", "magazine",
    ];
    let l = raw.to_lowercase();
    if CUES.iter().any(|c| l.contains(c)) {
        Classification::TypographyHeavy
    } else {
        Classification::Standard
    }
}

// ─── Stage 2a: Ideogram (typography route) ──────────────────────────────────

async fn route_ideogram(client: &reqwest::Client, prompt: &str, api_key: &str) -> Result<String, String> {
    let body = json!({
        "image_request": {
            "prompt": prompt,
            "model": "V_3",
            "magic_prompt_option": "AUTO",
            "aspect_ratio": "ASPECT_1_1",
        }
    });
    let v: Value = client
        .post(IDEOGRAM_URL)
        .header("Api-Key", api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| short_err(&e))?
        .error_for_status()
        .map_err(|e| short_err(&e))?
        .json()
        .await
        .map_err(|e| short_err(&e))?;
    // Ideogram replies with { data: [ { url: "https://…" } ] }.
    v.get("data")
        .and_then(|d| d.as_array())
        .and_then(|a| a.first())
        .and_then(|f| f.get("url"))
        .and_then(|u| u.as_str())
        .map(str::to_string)
        .ok_or_else(|| "no image url in Ideogram response".to_string())
}

// ─── Stage 2b: FLUX.1-[schnell] via ComfyUI (standard route) ────────────────

struct ImageRef {
    filename: String,
    subfolder: String,
    kind: String,
}

async fn route_flux(client: &reqwest::Client, prompt: &str) -> Result<String, String> {
    // 1) Queue a FLUX.1-[schnell] workflow. The graph below is a TEMPLATE — adapt
    //    the model filenames/node ids to your local ComfyUI install. In dev the
    //    POST simply fails to connect and we fall back before this matters.
    let queued: Value = client
        .post(format!("{COMFY_HOST}/prompt"))
        .json(&json!({ "prompt": flux_schnell_workflow(prompt) }))
        .send()
        .await
        .map_err(|e| short_err(&e))?
        .error_for_status()
        .map_err(|e| short_err(&e))?
        .json()
        .await
        .map_err(|e| short_err(&e))?;
    let prompt_id = queued
        .get("prompt_id")
        .and_then(Value::as_str)
        .ok_or_else(|| "ComfyUI did not return a prompt_id".to_string())?
        .to_string();

    // 2) Poll history (bounded) until the SaveImage node yields an image.
    for _ in 0..80 {
        tokio::time::sleep(Duration::from_millis(750)).await;
        let hist: Value = match client
            .get(format!("{COMFY_HOST}/history/{prompt_id}"))
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
        {
            Ok(r) => match r.json().await {
                Ok(j) => j,
                Err(_) => continue,
            },
            Err(_) => continue,
        };
        if let Some(img) = first_image_ref(&hist, &prompt_id) {
            // 3) Fetch the rendered bytes and inline as a data-URI.
            let bytes = client
                .get(format!("{COMFY_HOST}/view"))
                .query(&[
                    ("filename", img.filename.as_str()),
                    ("subfolder", img.subfolder.as_str()),
                    ("type", img.kind.as_str()),
                ])
                .send()
                .await
                .map_err(|e| short_err(&e))?
                .error_for_status()
                .map_err(|e| short_err(&e))?
                .bytes()
                .await
                .map_err(|e| short_err(&e))?;
            return Ok(format!("data:image/png;base64,{}", STANDARD.encode(&bytes)));
        }
    }
    Err("FLUX render timed out".into())
}

/// Pull the first produced image reference out of a ComfyUI `/history` payload.
fn first_image_ref(history: &Value, prompt_id: &str) -> Option<ImageRef> {
    let outputs = history.get(prompt_id)?.get("outputs")?.as_object()?;
    for node in outputs.values() {
        if let Some(images) = node.get("images").and_then(Value::as_array) {
            if let Some(first) = images.first() {
                return Some(ImageRef {
                    filename: first.get("filename")?.as_str()?.to_string(),
                    subfolder: first.get("subfolder").and_then(Value::as_str).unwrap_or("").to_string(),
                    kind: first.get("type").and_then(Value::as_str).unwrap_or("output").to_string(),
                });
            }
        }
    }
    None
}

/// A minimal FLUX.1-[schnell] ComfyUI workflow (API format). schnell's hallmark
/// is 4 steps at cfg 1.0. Model filenames are install-specific placeholders.
fn flux_schnell_workflow(prompt: &str) -> Value {
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    json!({
        "5": { "class_type": "EmptySD3LatentImage",
               "inputs": { "width": 1024, "height": 1024, "batch_size": 1 } },
        "6": { "class_type": "CLIPTextEncode",
               "inputs": { "text": prompt, "clip": ["11", 0] } },
        "8": { "class_type": "VAEDecode",
               "inputs": { "samples": ["13", 0], "vae": ["10", 0] } },
        "9": { "class_type": "SaveImage",
               "inputs": { "filename_prefix": "trenlens", "images": ["8", 0] } },
        "10": { "class_type": "VAELoader",
                "inputs": { "vae_name": "ae.safetensors" } },
        "11": { "class_type": "DualCLIPLoader",
                "inputs": { "clip_name1": "t5xxl_fp8_e4m3fn.safetensors",
                            "clip_name2": "clip_l.safetensors", "type": "flux" } },
        "12": { "class_type": "UNETLoader",
                "inputs": { "unet_name": "flux1-schnell.safetensors",
                            "weight_dtype": "fp8_e4m3fn" } },
        "13": { "class_type": "KSampler",
                "inputs": { "seed": seed, "steps": 4, "cfg": 1.0,
                            "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0,
                            "model": ["12", 0], "positive": ["6", 0],
                            "negative": ["6", 0], "latent_image": ["5", 0] } }
    })
}

// ─── Placeholder + helpers ──────────────────────────────────────────────────

/// A self-describing SVG data-URI shown when a model is offline (or no key). It
/// names the route it WOULD have taken and the classification, so the two-stage
/// choreography is legible even with nothing installed.
fn placeholder(route: &Classification, prompt: &str) -> String {
    let intended = match route {
        Classification::TypographyHeavy => "ideogram",
        Classification::Standard => "flux",
    };
    let snippet = xml_escape(&truncate(prompt, 110));
    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="768" height="768" viewBox="0 0 768 768">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0b0d12"/><stop offset="1" stop-color="#12161f"/>
    </linearGradient>
    <radialGradient id="p" cx="0.5" cy="0.38" r="0.62">
      <stop offset="0" stop-color="#6ea8fe" stop-opacity="0.30"/>
      <stop offset="1" stop-color="#6ea8fe" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="768" height="768" fill="url(#g)"/>
  <rect width="768" height="768" fill="url(#p)"/>
  <circle cx="384" cy="296" r="74" fill="none" stroke="#6ea8fe" stroke-width="2" opacity="0.85"/>
  <circle cx="384" cy="296" r="6" fill="#6ea8fe"/>
  <text x="384" y="432" text-anchor="middle" font-family="ui-sans-serif,system-ui,sans-serif" font-size="27" font-weight="600" fill="#e8edf5">Preview unavailable</text>
  <text x="384" y="468" text-anchor="middle" font-family="ui-monospace,monospace" font-size="15" fill="#9aa7bd">route: {intended} · {cls}</text>
  <text x="384" y="524" text-anchor="middle" font-family="ui-sans-serif,system-ui,sans-serif" font-size="14" fill="#7d8aa0">{snippet}</text>
  <text x="384" y="704" text-anchor="middle" font-family="ui-monospace,monospace" font-size="12" fill="#5a6678">local model offline — mock pipeline output</text>
</svg>"##,
        intended = intended,
        cls = route.as_str(),
        snippet = snippet,
    );
    format!("data:image/svg+xml;base64,{}", STANDARD.encode(svg.as_bytes()))
}

fn truncate(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Compact, secret-free description of a reqwest failure for the `note` field.
fn short_err(e: &reqwest::Error) -> String {
    if e.is_connect() {
        "connection refused".into()
    } else if e.is_timeout() {
        "timed out".into()
    } else if let Some(status) = e.status() {
        format!("HTTP {}", status.as_u16())
    } else {
        "request failed".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classification_parse_and_str() {
        assert_eq!(Classification::parse("typography_heavy"), Classification::TypographyHeavy);
        assert_eq!(Classification::parse("STANDARD"), Classification::Standard);
        assert_eq!(Classification::parse("nonsense"), Classification::Standard);
        assert_eq!(Classification::TypographyHeavy.as_str(), "typography_heavy");
    }

    #[test]
    fn heuristic_detects_text_intent() {
        assert_eq!(classify_heuristic("a minimalist logo for a coffee shop"), Classification::TypographyHeavy);
        assert_eq!(classify_heuristic("movie poster with a bold title"), Classification::TypographyHeavy);
        assert_eq!(classify_heuristic("a cat sleeping on a velvet sofa"), Classification::Standard);
    }

    #[test]
    fn placeholder_is_a_valid_svg_data_uri() {
        let uri = placeholder(&Classification::Standard, "a cat");
        assert!(uri.starts_with("data:image/svg+xml;base64,"));
        let b64 = uri.trim_start_matches("data:image/svg+xml;base64,");
        let svg = String::from_utf8(STANDARD.decode(b64).unwrap()).unwrap();
        assert!(svg.contains("<svg"));
        assert!(svg.contains("route: flux"));
    }

    #[test]
    fn placeholder_escapes_prompt() {
        let uri = placeholder(&Classification::TypographyHeavy, "a <script> & \"quotes\"");
        let b64 = uri.trim_start_matches("data:image/svg+xml;base64,");
        let svg = String::from_utf8(STANDARD.decode(b64).unwrap()).unwrap();
        assert!(!svg.contains("<script>"));
        assert!(svg.contains("&lt;script&gt;"));
        assert!(svg.contains("route: ideogram"));
    }

    #[test]
    fn finds_first_comfy_image() {
        let hist = json!({
            "abc": { "outputs": { "9": { "images": [
                { "filename": "trenlens_0001.png", "subfolder": "", "type": "output" }
            ] } } }
        });
        let img = first_image_ref(&hist, "abc").expect("image ref");
        assert_eq!(img.filename, "trenlens_0001.png");
        assert_eq!(img.kind, "output");
        assert!(first_image_ref(&hist, "missing").is_none());
    }

    #[test]
    fn truncate_respects_limit() {
        assert_eq!(truncate("short", 110), "short");
        let long = "x".repeat(200);
        let t = truncate(&long, 110);
        assert_eq!(t.chars().count(), 110);
        assert!(t.ends_with('…'));
    }
}
