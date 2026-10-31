/** The preview wire contract uses radians. New editor APIs return degrees. */
export function previewRotationRadians(rotation: number, version: readonly number[]): number {
    const [major = 0, minor = 0, patch = 0] = version;
    const degrees = major > 3 || major === 3 && (minor > 2 || minor === 2 && patch > 149);
    return degrees ? rotation * Math.PI / 180 : rotation;
}
