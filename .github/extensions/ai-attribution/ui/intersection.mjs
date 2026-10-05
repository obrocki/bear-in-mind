const AVAILABLE = new Set(['native', 'partial', 'derived']);

export function intersectConcepts(model) {
  if (!model.surfaces.length) return [];
  return model.concepts
    .filter((concept) => model.surfaces.every((surface) => AVAILABLE.has(concept.surfaces[surface.id]?.availability)))
    .map((concept) => ({
      ...concept,
      intersectionAvailability: model.surfaces.every((surface) => concept.surfaces[surface.id].availability === 'native')
        ? 'native'
        : 'partial',
    }));
}
