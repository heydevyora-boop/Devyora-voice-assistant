import { Link } from 'react-router-dom';
import { Icon } from '@/components/primitives/Icon';
import type { GlyphName } from '@/features/orb/types';

export interface PlaceholderScreenProps {
  title: string;
  glyph: GlyphName;
  /** Plain statement of what this surface will do and when it arrives. */
  summary: string;
  arrivesIn: string;
}

/**
 * An honest stub. These routes exist so navigation is real from this chunk
 * onward, but they do not pretend to hold functionality that has not been
 * built yet.
 */
export function PlaceholderScreen({ title, glyph, summary, arrivesIn }: PlaceholderScreenProps) {
  return (
    <section className="flex min-h-[100dvh] flex-col items-center justify-center px-margin-sm pb-32 pt-20">
      <div className="glass-floating w-full max-w-stage rounded-md p-space-lg text-center">
        <div className="mx-auto mb-space-sm flex h-12 w-12 items-center justify-center rounded-full bg-surface-container-high text-primary">
          <Icon name={glyph} size={24} />
        </div>
        <h1 className="font-display text-headline-md text-on-surface">{title}</h1>
        <p className="mx-auto mt-space-xs max-w-[40ch] font-body text-body-md text-on-surface-variant">
          {summary}
        </p>
        <p className="mt-space-sm font-display text-label-sm uppercase tracking-[0.06em] text-primary">
          {arrivesIn}
        </p>
        <Link
          to="/"
          className="mt-space-md inline-flex h-11 items-center gap-1.5 rounded-full bg-surface-container-high px-5 text-on-surface-variant transition-colors hover:text-on-surface"
        >
          <Icon name="orb" size={16} />
          <span className="font-display text-label-md">Back to the orb</span>
        </Link>
      </div>
    </section>
  );
}
