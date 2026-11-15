"use client";

import { useRef, useEffect } from "react";
import gsap from "gsap";

interface ShiningTextProps {
  text: string;
  className?: string;
}

export function ShiningText({ text, className = "" }: ShiningTextProps) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const tl = gsap.timeline({ repeat: -1 });
    tl.fromTo(
      ref.current,
      { backgroundPosition: "200% 0" },
      { backgroundPosition: "-200% 0", duration: 2.5, ease: "none" }
    );
    return () => { tl.kill(); };
  }, []);

  return (
    <span
      ref={ref}
      className={`bg-[linear-gradient(110deg,#9ca3af,35%,#374151,50%,#9ca3af,75%,#9ca3af)] bg-[length:200%_100%] bg-clip-text text-transparent ${className}`}
      style={{ backgroundPosition: "200% 0" }}
    >
      {text}
    </span>
  );
}
