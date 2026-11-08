import { useEffect, useState } from 'react';

export type Breakpoint = 'mobile' | 'tablet' | 'desktop';

/** DESIGN.md: mobile < 768, tablet 768–1024, desktop > 1024. */
function read(): Breakpoint {
  if (typeof window === 'undefined') return 'mobile';
  const w = window.innerWidth;
  if (w >= 1024) return 'desktop';
  if (w >= 768) return 'tablet';
  return 'mobile';
}

export function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>(read);

  useEffect(() => {
    let frame = 0;
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setBp(read()));
    };
    window.addEventListener('resize', onResize, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  return bp;
}
