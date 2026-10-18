import type { CSSProperties } from "react";

const PARTICLES = Array.from({ length: 18 }, (_, index) => ({
  id: index,
  left: `${(index * 37) % 100}%`,
  top: `${(index * 61) % 100}%`,
  delay: `${(index % 7) * 0.7}s`,
  duration: `${8 + (index % 5) * 2}s`,
}));

export default function AmbientBackground() {
  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-bg-base">
      <div className="ambient-gradient absolute inset-0 opacity-40" aria-hidden="true" />
      <div className="ambient-grid absolute inset-0 opacity-30" aria-hidden="true" />
      <div className="hearts-layer hearts-layer-a" aria-hidden="true" />
      <div className="hearts-layer hearts-layer-b" aria-hidden="true" />
      <div className="hearts-layer hearts-layer-c" aria-hidden="true" />
      <div
        className="ambient-halo ambient-halo-pink absolute -left-40 -top-40"
        aria-hidden="true"
      />
      <div
        className="ambient-halo ambient-halo-cyan absolute -bottom-48 -right-40"
        aria-hidden="true"
      />
      <div className="absolute inset-0" aria-hidden="true">
        {PARTICLES.map((particle) => (
          <span
            key={particle.id}
            className="ambient-particle absolute h-1 w-1 rounded-full bg-accent-primary"
            style={
              {
                left: particle.left,
                top: particle.top,
                "--particle-delay": particle.delay,
                "--particle-duration": particle.duration,
              } as CSSProperties
            }
          />
        ))}
      </div>
    </div>
  );
}
