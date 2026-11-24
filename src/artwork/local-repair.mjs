// A reviewed, locally registered Flash portrait can try one different mask fit.
// Other defects (or a second rejection) have no automatic paid fallback.
export function localRepairCriteria(stage) {
  if(stage?.stage!=='artwork'||stage.status!=='blocked'||!stage.processorSha256||
    stage.visualReview?.status!=='failed'||stage.localMaterialRepair||
    !stage.unresolved?.some(i=>i.code==='ARTWORK_VISUAL_REVIEW_FAILED'))return [];
  const failures=stage.checks.filter(c=>c.layer==='visual'&&c.status==='failed').map(c=>c.name);
  return failures.length&&failures.every(c=>c==='half-blink'||c==='occlusion-completion')?[...new Set(failures)].sort():[];
}
