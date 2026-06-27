import type { CSSProperties } from "react";

/** The Tally glyph: four vertical strokes crossed by a diagonal fifth. */
export function TallyMark({
  className = "",
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      viewBox="0 0 28 24"
      fill="none"
      className={className}
      style={style}
      aria-hidden
    >
      {[4, 9, 14, 19].map((x) => (
        <line
          key={x}
          x1={x}
          y1={4}
          x2={x}
          y2={20}
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
        />
      ))}
      <line
        x1={2}
        y1={18.5}
        x2={22}
        y2={5.5}
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Mark + wordmark lockup used in headers. */
export function TallyLogo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <TallyMark className="h-[18px] w-[21px] text-ink" />
      <span className="text-[15px] font-semibold tracking-[0.22em] text-ink">
        TALLY
      </span>
    </span>
  );
}
