/**
 * Zoom-aware photo clustering.
 *
 * Clustering happens in screen pixels rather than degrees, so a cluster always
 * means "these would overlap on screen right now". Zooming in therefore pulls
 * clusters apart on its own, which is exactly the behaviour we want.
 *
 * Greedy nearest-neighbour with a uniform grid index: O(n) for the shapes of
 * data a photo album produces, and stable enough that markers don't twitch.
 */

export function clusterPhotos(photos, project, radius) {
  const points = photos.map((photo) => {
    const { x, y } = project(photo);
    return { photo, x, y, taken: false };
  });

  // Sorting makes cluster seeds deterministic: same input, same output.
  points.sort((a, b) => a.x - b.x || a.y - b.y);

  const cell = Math.max(radius, 1);
  const grid = new Map();
  const key = (cx, cy) => `${cx}|${cy}`;
  for (const p of points) {
    const k = key(Math.floor(p.x / cell), Math.floor(p.y / cell));
    let bucket = grid.get(k);
    if (!bucket) grid.set(k, (bucket = []));
    bucket.push(p);
  }

  const radiusSq = radius * radius;
  const clusters = [];

  for (const seed of points) {
    if (seed.taken) continue;
    seed.taken = true;
    const members = [seed];

    const cx = Math.floor(seed.x / cell);
    const cy = Math.floor(seed.y / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(key(cx + dx, cy + dy));
        if (!bucket) continue;
        for (const candidate of bucket) {
          if (candidate.taken) continue;
          const ddx = candidate.x - seed.x;
          const ddy = candidate.y - seed.y;
          if (ddx * ddx + ddy * ddy <= radiusSq) {
            candidate.taken = true;
            members.push(candidate);
          }
        }
      }
    }

    clusters.push(makeCluster(members));
  }

  return clusters;
}

function makeCluster(members) {
  let sumX = 0;
  let sumY = 0;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;

  for (const m of members) {
    sumX += m.x;
    sumY += m.y;
    const { lat, lon } = m.photo;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }

  const centerX = sumX / members.length;
  const centerY = sumY / members.length;

  // The cover photo is the one closest to the middle of the pile.
  let cover = members[0];
  let best = Infinity;
  for (const m of members) {
    const d = (m.x - centerX) ** 2 + (m.y - centerY) ** 2;
    if (d < best) { best = d; cover = m; }
  }

  const photos = members.map((m) => m.photo);
  photos.sort((a, b) => (Date.parse(a.takenAt || 0) || 0) - (Date.parse(b.takenAt || 0) || 0));

  return {
    id: `c${photos.length}:${cover.photo.id}`,
    x: centerX,
    y: centerY,
    cover: cover.photo,
    photos,
    count: photos.length,
    bounds: [[minLat, minLon], [maxLat, maxLon]],
  };
}

/**
 * Positions for exploding a cluster in place ("spiderfy"), used when the
 * photos share coordinates so closely that zooming can't separate them.
 * Small clusters get a ring; larger ones a spiral so labels stay readable.
 */
export function spiderPositions(count, { ringRadius = 46, spiralStep = 12 } = {}) {
  const positions = [];
  if (count <= 9) {
    const radius = ringRadius + count * 3;
    for (let i = 0; i < count; i++) {
      const angle = (2 * Math.PI * i) / count - Math.PI / 2;
      positions.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
    }
    return positions;
  }
  let angle = 0;
  let radius = ringRadius;
  for (let i = 0; i < count; i++) {
    positions.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
    angle += Math.max(spiralStep / radius, 0.35);
    radius += (spiralStep * 2.4) / (2 * Math.PI);
  }
  return positions;
}
