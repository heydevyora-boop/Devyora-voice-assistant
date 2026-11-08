import type { ReactNode } from 'react';
import { cn } from './cn';

export interface GlassCardProps {
  children: ReactNode;
  /** Colour of the hairline that runs along the top edge. */
  accent?: string;
  className?: string;
  role?: string;
  'aria-live'?: 'polite' | 'assertive';
}

/** Tier 2 floating surface with the specular top hairline from DESIGN.md. */
export function GlassCard({ children, accent, className, role, ...rest }: GlassCardProps) {
  return (
    <div
      role={role}
      aria-live={rest['aria-live']}
      className={cn('glass-floating relative overflow-hidden rounded-md', className)}
    >
      {accent ? (
        <span
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-px"
          style={{ background: `linear-gradient(90deg, transparent, ${accent}, transparent)` }}
        />
      ) : null}
      {children}
    </div>
  );
}
