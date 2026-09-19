import { useEffect, useRef, useState, type CSSProperties } from "react";

const PARTICLES = Array.from({ length: 18 }, (_, index) => ({
  id: index,
  left: `${(index * 37) % 100}%`,
  top: `${(index * 61) % 100}%`,
  delay: `${(index % 7) * 0.7}s`,
  duration: `${8 + (index % 5) * 2}s`,
}));

interface AmbientBackgroundProps {
  onStarClick: () => void;
}

export default function AmbientBackground({ onStarClick }: AmbientBackgroundProps) {
  const [starPosition, setStarPosition] = useState({ top: 24, left: 82 });
  const [isStarVisible, setIsStarVisible] = useState(false);
  const starCooldownUntil = useRef(0);

  useEffect(() => {
    const showStar = () => {
      if (Date.now() < starCooldownUntil.current) return;
      setStarPosition({ top: 15 + Math.random() * 65, left: 8 + Math.random() * 84 });
      setIsStarVisible(true);
      window.setTimeout(() => setIsStarVisible(false), 5000);
    };

    const initialTimer = window.setTimeout(showStar, 7000);
    const interval = window.setInterval(showStar, 60_000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
    };
  }, []);

  const handleStarClick = () => {
    starCooldownUntil.current = Date.now() + 30 * 60_000;
    setIsStarVisible(false);
    onStarClick();
  };

  return (
    <>
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-bg-base">
        <div
          className="ambient-gradient absolute inset-0 opacity-70"
          aria-hidden="true"
        />
        <div className="ambient-grid absolute inset-0 opacity-30" aria-hidden="true" />
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
      {isStarVisible && (
        <button
          type="button"
          aria-label="Descubrir una sorpresa"
          onClick={handleStarClick}
          className="ambient-star pointer-events-auto fixed z-40 text-lg text-accent-secondary opacity-70 transition duration-200 ease-bounce hover:scale-150 hover:opacity-100"
          style={{ top: `${starPosition.top}%`, left: `${starPosition.left}%` }}
        >
          ✦
        </button>
      )}
    </>
  );
}
