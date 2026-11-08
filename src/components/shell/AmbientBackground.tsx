/**
 * Tier 0 of the elevation model: the void ground plus three large diffuse
 * spectral blooms.
 *
 * The blooms are multi-stop radial gradients, not blurred solids. A
 * `filter: blur()` is clipped to the element's compositor layer, so each
 * bloom drew a faint straight edge across the page wherever that layer ended —
 * visible as a square halo behind the orb. Gradients have no layer bounds to
 * clip against, and they are cheaper to paint at this size.
 */
function bloom(color: string, falloff: readonly [number, number, number]): string {
  const [a, b, c] = falloff;
  return `radial-gradient(circle closest-side,
    color-mix(in srgb, ${color} ${a}%, transparent) 0%,
    color-mix(in srgb, ${color} ${b}%, transparent) 42%,
    color-mix(in srgb, ${color} ${c}%, transparent) 70%,
    transparent 100%)`;
}

export function AmbientBackground() {
  return (
    <div
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
      aria-hidden="true"
    >
      <div
        className="absolute left-1/2 h-[42rem] w-[42rem] -translate-x-1/2 -translate-y-1/3 rounded-full"
        style={{ background: bloom('#4cd7f6', [9, 5, 2]) }}
      />
      <div
        className="absolute top-1/4 right-0 h-[34rem] w-[34rem] translate-x-1/3 rounded-full"
        style={{ background: bloom('#d0bcff', [8, 4, 1.5]) }}
      />
      <div
        className="absolute bottom-0 left-0 h-[30rem] w-[30rem] -translate-x-1/4 translate-y-1/4 rounded-full"
        style={{ background: bloom('#fbabff', [7, 3.5, 1.5]) }}
      />
    </div>
  );
}
