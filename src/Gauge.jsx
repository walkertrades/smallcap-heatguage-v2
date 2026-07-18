// Premium radial heat gauge — semicircle with a gradient zone arc and a glowing
// knob riding the needle tip. The big score/label lives in the hero card next to
// it; this component is just the dial. Needle position is zone-accurate.
const { useEffect, useState, useRef } = React;

function useSpring(target, { stiffness = 0.12, damping = 0.78 } = {}) {
  const [val, setVal] = useState(target);
  const ref = useRef({ v: target, vel: 0 });
  useEffect(() => {
    let raf;
    const tick = () => {
      const cur = ref.current;
      const force = (target - cur.v) * stiffness;
      cur.vel = (cur.vel + force) * damping;
      cur.v += cur.vel;
      if (Math.abs(target - cur.v) < 0.05 && Math.abs(cur.vel) < 0.05) {
        cur.v = target; cur.vel = 0; setVal(target); return;
      }
      setVal(cur.v);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, stiffness, damping]);
  return val;
}

// Direct 0–100 → position mapping so the needle always sits at the score's
// proportional place on the arc (42 → left-of-center, 66 → into the hot right).
// Visual zone boundaries (in score): COLD 0–45 · NEUTRAL 45–62 · HOT 62–100.
const ZONE_EDGE = { coldTop: 45, hotBottom: 62 };
function scoreToDeg(score) { return clampS(score, 0, 100) / 100 * 180; }
function clampS(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function gaugeZone(score) {
  if (score < ZONE_EDGE.coldTop) return "COLD";
  if (score < ZONE_EDGE.hotBottom) return "NEUTRAL";
  return "HOT";
}

function Gauge({ score, state, size = "lg" }) {
  const targetAngle = score == null ? 0 : scoreToDeg(score) - 90;
  const angle = useSpring(targetAngle);

  const cx = 200, cy = 185, r = 150, strokeW = 20;
  const isEmpty = score == null;

  const polar = (deg, rad) => {
    const a = ((deg - 180) * Math.PI) / 180;
    return { x: cx + rad * Math.cos(a), y: cy + rad * Math.sin(a) };
  };
  const arcPath = (startDeg, endDeg, rad) => {
    const s = polar(startDeg, rad), e = polar(endDeg, rad);
    const large = endDeg - startDeg > 180 ? 1 : 0;
    return `M ${s.x} ${s.y} A ${rad} ${rad} 0 ${large} 1 ${e.x} ${e.y}`;
  };

  // The ARC communicates state — the needle stays neutral white/light gray.
  const zone = isEmpty ? null : gaugeZone(score);
  const knobColor = "oklch(0.97 0.005 260)";
  const coldEnd = scoreToDeg(ZONE_EDGE.coldTop);
  const hotStart = scoreToDeg(ZONE_EDGE.hotBottom);

  // Knob rides the animated needle tip.
  const tipDeg = angle + 90;
  const tip = polar(tipDeg, r);

  const ticks = [];
  for (let i = 0; i <= 20; i++) {
    const p1 = polar((i / 20) * 180, r - strokeW - 3);
    const p2 = polar((i / 20) * 180, r - strokeW - (i % 5 === 0 ? 11 : 6));
    ticks.push({ ...p1, x2: p2.x, y2: p2.y, major: i % 5 === 0 });
  }

  return (
    <div className="gauge-wrap">
      <svg viewBox="0 0 400 210" className="gauge-svg">
        <defs>
          {/* one continuous cold → amber → hot gradient across the dial */}
          <linearGradient id="gaugeGrad" gradientUnits="userSpaceOnUse" x1={cx - r} y1="0" x2={cx + r} y2="0">
            <stop offset="0%"   stopColor="oklch(0.62 0.18 255)" />
            <stop offset="26%"  stopColor="oklch(0.68 0.15 215)" />
            <stop offset="48%"  stopColor="oklch(0.80 0.15 150)" />
            <stop offset="68%"  stopColor="oklch(0.86 0.16 95)" />
            <stop offset="86%"  stopColor="oklch(0.76 0.19 55)" />
            <stop offset="100%" stopColor="oklch(0.64 0.23 28)" />
          </linearGradient>
          <filter id="knobGlow" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="4" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        {/* track */}
        <path d={arcPath(0, 180, r)} stroke="var(--card-border)" strokeWidth={strokeW + 4} fill="none" strokeLinecap="round" />

        {/* Active-zone highlight. NOTE: this used to be a feGaussianBlur filter,
            but a blurred short arc renders as a floating ellipse that doesn't
            follow the curve. Stroking the SAME arc path wider at low opacity
            gives a halo that traces the arc exactly. */}
        {!isEmpty && (
          <path
            d={arcPath(
              zone === "COLD" ? 0 : zone === "NEUTRAL" ? coldEnd : hotStart,
              zone === "COLD" ? coldEnd : zone === "NEUTRAL" ? hotStart : 180,
              r
            )}
            stroke="url(#gaugeGrad)" strokeWidth={strokeW + 10} fill="none"
            strokeLinecap="round" opacity="0.22"
          />
        )}

        {/* the single continuous gradient arc */}
        <path d={arcPath(0, 180, r)} stroke="url(#gaugeGrad)" strokeWidth={strokeW} fill="none" strokeLinecap="round" opacity={isEmpty ? 0.3 : 1} />

        {/* ticks */}
        {ticks.map((t, i) => (
          <line key={i} x1={t.x} y1={t.y} x2={t.x2} y2={t.y2}
            stroke={t.major ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.16)"}
            strokeWidth={t.major ? 1.3 : 0.8} />
        ))}

        {/* end labels */}
        <text x={polar(0, r).x - 2} y={polar(0, r).y + 22} textAnchor="middle" className="gauge-end-label">0</text>
        <text x={polar(180, r).x + 2} y={polar(180, r).y + 22} textAnchor="middle" className="gauge-end-label">100</text>

        {!isEmpty && (
          <>
            {/* needle */}
            <line x1={cx} y1={cy} x2={tip.x} y2={tip.y} stroke={knobColor} strokeWidth="3" strokeLinecap="round" opacity="0.85" />
            {/* hub */}
            <circle cx={cx} cy={cy} r="8" fill="var(--bg)" stroke={knobColor} strokeWidth="2" />
            {/* glowing knob at tip */}
            <g filter="url(#knobGlow)">
              <circle cx={tip.x} cy={tip.y} r="9" fill={knobColor} opacity="0.28" />
              <circle cx={tip.x} cy={tip.y} r="6.5" fill={knobColor} />
              <circle cx={tip.x} cy={tip.y} r="2.6" fill="var(--bg)" />
            </g>
          </>
        )}
      </svg>
    </div>
  );
}

Object.assign(window, { Gauge });
