"use client";

import { useRef, useEffect } from "react";
import gsap from "gsap";

interface DotMatrixProps {
  /** Grid columns */
  cols?: number;
  /** Grid rows */
  rows?: number;
  /** Dot size in px */
  dotSize?: number;
  /** Gap between dots in px */
  gap?: number;
  /** Active dot color */
  color?: string;
  /** Inactive dot color */
  offColor?: string;
  /** Glow color */
  glowColor?: string;
  /** Animation pattern */
  pattern?: "wave" | "pulse" | "random";
  /** Speed multiplier (lower = faster) */
  speed?: number;
}

export function DotMatrix({
  cols = 5,
  rows = 5,
  dotSize = 4,
  gap = 3,
  color = "#2E2E2E",
  offColor = "#d4d4d8",
  glowColor = "#2E2E2E",
  pattern = "wave",
  speed = 1,
}: DotMatrixProps) {
  const gridRef = useRef<HTMLDivElement>(null);
  const tlRef = useRef<gsap.core.Timeline | null>(null);

  useEffect(() => {
    if (!gridRef.current) return;
    const dots = gridRef.current.querySelectorAll<HTMLDivElement>(".dot");
    if (!dots.length) return;

    // Kill previous
    if (tlRef.current) tlRef.current.kill();

    const total = cols * rows;

    if (pattern === "wave") {
      const tl = gsap.timeline({ repeat: -1 });
      // Wave sweeps diagonally
      for (let i = 0; i < total; i++) {
        const row = Math.floor(i / cols);
        const col = i % cols;
        const delay = (row + col) * 0.08 * speed;

        tl.to(dots[i], {
          backgroundColor: color,
          boxShadow: `0 0 ${dotSize * 2}px 0 ${glowColor}40`,
          scale: 1.3,
          duration: 0.15 * speed,
          ease: "power2.in",
        }, delay);

        tl.to(dots[i], {
          backgroundColor: offColor,
          boxShadow: "none",
          scale: 1,
          duration: 0.4 * speed,
          ease: "power2.out",
        }, delay + 0.15 * speed);
      }
      tlRef.current = tl;
    } else if (pattern === "pulse") {
      const tl = gsap.timeline({ repeat: -1 });
      // Pulse from center outward
      const centerR = (rows - 1) / 2;
      const centerC = (cols - 1) / 2;

      for (let i = 0; i < total; i++) {
        const row = Math.floor(i / cols);
        const col = i % cols;
        const dist = Math.sqrt((row - centerR) ** 2 + (col - centerC) ** 2);
        const delay = dist * 0.12 * speed;

        tl.to(dots[i], {
          backgroundColor: color,
          boxShadow: `0 0 ${dotSize * 2}px 0 ${glowColor}40`,
          scale: 1.3,
          duration: 0.12 * speed,
          ease: "power2.in",
        }, delay);

        tl.to(dots[i], {
          backgroundColor: offColor,
          boxShadow: "none",
          scale: 1,
          duration: 0.35 * speed,
          ease: "power2.out",
        }, delay + 0.12 * speed);
      }
      tlRef.current = tl;
    } else {
      // Random twinkling
      const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.3 * speed });

      for (let wave = 0; wave < 3; wave++) {
        const indices = Array.from({ length: total }, (_, i) => i)
          .sort(() => Math.random() - 0.5)
          .slice(0, Math.ceil(total * 0.4));

        indices.forEach((i, j) => {
          const delay = wave * 0.8 * speed + j * 0.03 * speed;
          tl.to(dots[i], {
            backgroundColor: color,
            boxShadow: `0 0 ${dotSize * 2}px 0 ${glowColor}40`,
            scale: 1.3,
            duration: 0.1 * speed,
            ease: "power2.in",
          }, delay);
          tl.to(dots[i], {
            backgroundColor: offColor,
            boxShadow: "none",
            scale: 1,
            duration: 0.3 * speed,
            ease: "power2.out",
          }, delay + 0.1 * speed);
        });
      }
      tlRef.current = tl;
    }

    return () => {
      if (tlRef.current) tlRef.current.kill();
    };
  }, [cols, rows, dotSize, color, offColor, glowColor, pattern, speed]);

  return (
    <div
      ref={gridRef}
      className="inline-grid"
      style={{
        gridTemplateColumns: `repeat(${cols}, ${dotSize}px)`,
        gap: `${gap}px`,
      }}
    >
      {Array.from({ length: cols * rows }).map((_, i) => (
        <div
          key={i}
          className="dot rounded-full"
          style={{
            width: dotSize,
            height: dotSize,
            backgroundColor: offColor,
            transition: "none",
          }}
        />
      ))}
    </div>
  );
}
