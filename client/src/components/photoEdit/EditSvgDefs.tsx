import { type EditAdj } from "./editAdj";

function toneTableValues(exposure: number, highlights: number, shadows: number): string {
  const expMult = 1 + (exposure / 100) * 0.7;
  const shadStr = -(shadows / 100) * 0.45;
  const hiStr = (highlights / 100) * 0.25;
  return Array.from({ length: 11 }, (_, i) => {
    const x = i / 10;
    let v = Math.max(0, x * expMult);
    v += shadStr * (1 - Math.min(1, v)) * (1 - Math.min(1, v));
    v += hiStr * v * v;
    return Math.max(0, Math.min(1, v)).toFixed(4);
  }).join(" ");
}
function colorMatrixValues(temperature: number, tint: number): string {
  const t = temperature / 100;
  const n = tint / 100;
  const r = (1 + t * 0.18).toFixed(4);
  const g = ((1 - Math.abs(t) * 0.03) * (1 - n * 0.12)).toFixed(4);
  const b = (1 - t * 0.18).toFixed(4);
  return `${r} 0 0 0 0  0 ${g} 0 0 0  0 0 ${b} 0 0  0 0 0 1 0`;
}
export function EditSvgDefs({ adj, filterId }: { adj: EditAdj; filterId: string }) {
  const toneVals = toneTableValues(adj.exposure, adj.highlights, adj.shadows);
  const colorMat = colorMatrixValues(adj.temperature, adj.tint);
  const sharpAmt = (adj.sharpness / 100 * 1.2).toFixed(3);
  const sharpK2 = (1 + adj.sharpness / 100 * 1.2).toFixed(3);
  const clarAmt = (adj.clarity / 100 * 0.6).toFixed(3);
  const clarK2 = (1 + adj.clarity / 100 * 0.6).toFixed(3);
  const needsSharp = adj.sharpness > 0;
  const needsClarity = adj.clarity > 0;
  const needsDehaze = adj.dehaze !== 0;
  const dehazeH = Math.abs(adj.dehaze / 100) * 0.5;
  const dehazeSlope = adj.dehaze > 0 ? 1 / (1 - dehazeH) : 1 - dehazeH;
  const dehazeIntercept = adj.dehaze > 0 ? -dehazeH / (1 - dehazeH) : dehazeH;
  const postToneResult = needsDehaze ? "dehazed" : "toned";

  return (
    <svg
      width="0"
      height="0"
      aria-hidden="true"
      style={{ position: "absolute", overflow: "hidden", pointerEvents: "none" }}
    >
      <defs>
        <filter
          id={filterId}
          x="-10%"
          y="-10%"
          width="120%"
          height="120%"
          colorInterpolationFilters="sRGB"
        >
          <feColorMatrix type="matrix" values={colorMat} result="colored" />
          <feComponentTransfer in="colored" result="toned">
            <feFuncR type="table" tableValues={toneVals} />
            <feFuncG type="table" tableValues={toneVals} />
            <feFuncB type="table" tableValues={toneVals} />
          </feComponentTransfer>
          {needsDehaze && (
            <feComponentTransfer in="toned" result="dehazed">
              <feFuncR type="linear" slope={dehazeSlope.toFixed(4)} intercept={dehazeIntercept.toFixed(4)} />
              <feFuncG type="linear" slope={dehazeSlope.toFixed(4)} intercept={dehazeIntercept.toFixed(4)} />
              <feFuncB type="linear" slope={dehazeSlope.toFixed(4)} intercept={dehazeIntercept.toFixed(4)} />
            </feComponentTransfer>
          )}
          {needsSharp && (
            <>
              <feGaussianBlur in={postToneResult} stdDeviation="1.2" result="sharpBlur" />
              <feComposite
                in={postToneResult}
                in2="sharpBlur"
                operator="arithmetic"
                k1="0"
                k2={sharpK2}
                k3={`-${sharpAmt}`}
                k4="0"
                result={needsClarity ? "sharpened" : undefined}
              />
            </>
          )}
          {needsClarity && (
            <>
              <feGaussianBlur
                in={needsSharp ? "sharpened" : postToneResult}
                stdDeviation="8"
                result="clarBlur"
              />
              <feComposite
                in={needsSharp ? "sharpened" : postToneResult}
                in2="clarBlur"
                operator="arithmetic"
                k1="0"
                k2={clarK2}
                k3={`-${clarAmt}`}
                k4="0"
              />
            </>
          )}
        </filter>
      </defs>
    </svg>
  );
}

// ─── Slider ────────────────────────────────────────────────────────────────
