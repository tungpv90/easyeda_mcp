export type ArcPoint = { x: number; y: number };

/**
 * Flatten an EasyEDA polygon `ARC`/`CARC` segment into points after `start`.
 * The segment is `ARC sweepDeg endX endY`; positive sweep is counterclockwise
 * in the native Y-up PCB frame. The returned points end exactly at `end`.
 */
export function arcPoints(start: ArcPoint, end: ArcPoint, sweepDeg: number, maxStepDeg = 10): ArcPoint[] {
    const sweep = sweepDeg * Math.PI / 180;
    const chord = Math.hypot(end.x - start.x, end.y - start.y);
    if (!Number.isFinite(sweep) || Math.abs(sweep) < 1e-9 || chord < 1e-9) return [end];

    const radius = chord / (2 * Math.sin(Math.abs(sweep) / 2));
    const midX = (start.x + end.x) / 2;
    const midY = (start.y + end.y) / 2;
    const offset = Math.sqrt(Math.max(radius * radius - (chord / 2) ** 2, 0));
    const ux = (end.x - start.x) / chord;
    const uy = (end.y - start.y) / chord;
    // The center lies left of the chord for counterclockwise sweeps below 180 degrees.
    const side = (sweep > 0) === (Math.abs(sweep) <= Math.PI) ? 1 : -1;
    const cx = midX - side * uy * offset;
    const cy = midY + side * ux * offset;

    const startAngle = Math.atan2(start.y - cy, start.x - cx);
    const steps = Math.max(1, Math.ceil(Math.abs(sweepDeg) / maxStepDeg));
    const points: ArcPoint[] = [];
    for (let i = 1; i < steps; i++) {
        const angle = startAngle + sweep * i / steps;
        points.push({ x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
    }
    points.push(end);
    return points;
}
