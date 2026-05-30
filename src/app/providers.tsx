'use client';

import { ThemeProvider } from 'next-themes';
import { ThemeWipeProvider } from '@/components/theme/ThemeTransition';

/**
 * Client-side provider stack. `disableTransitionOnChange` is intentionally OFF —
 * we WANT the CSS color transitions; the visual handoff is choreographed by
 * <ThemeWipeProvider>, not suppressed.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem={false}
      storageKey="trenlens-theme"
    >
      <ThemeWipeProvider>{children}</ThemeWipeProvider>
    </ThemeProvider>
  );
}
