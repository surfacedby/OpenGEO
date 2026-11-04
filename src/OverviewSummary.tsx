import { ArrowRight, Link, LoaderCircle, MessagesSquare, PauseCircle } from 'lucide-react';
import { CoverageRing } from './ui/Primitives';
import type { Presentation } from '../server/presentation';
import type { Job } from '../server/contracts';
import { completedMeasurement } from '../server/portable-results';

/** The overview reads the same mutually exclusive outcome counts as the evidence panels. */
export function OverviewSummary({ brand, presentation, collected, missing, active, onAnswers, onCheck }: { brand: string; presentation: Presentation; collected: number; missing: number; active?: Job; onAnswers: () => void; onCheck: () => void }) {
  const cited = presentation.outcomes.find(group => group.kind === 'cited')?.count ?? 0;
  if (active) return <section className="overview-activity" aria-label="Current activity">
    {active.status === 'paused' ? <PauseCircle size={24} aria-hidden="true" /> : <LoaderCircle size={24} className="loading-spin" aria-hidden="true" />}
    <div className="overview-summary-copy">
      <h2>{active.status === 'paused' ? 'Your visibility check needs attention' : completedMeasurement(active) ? 'Turning your answers into useful next steps' : `Checking where AI recommends ${brand}`}</h2>
      <p role="status">{active.progress || 'Preparing your questions. Answers are saved as they arrive.'}</p>
    </div>
    <button className="secondary" onClick={onCheck}>{active.status === 'paused' ? 'Review paused check' : 'View current check'}<ArrowRight size={16} /></button>
  </section>;
  return <section className="overview-summary" aria-label="Your visibility at a glance">
    <div className="overview-summary-copy">
      <h2>{collected ? cited ? <>{brand} is a source in <strong>{cited} of {collected}</strong> collected answers.</> : <>{brand} has no website citations in this check.</> : <>Does AI recommend {brand}?</>}</h2>
      <p>{collected ? `${missing ? `${missing} requested answers are still missing. ` : ''}Explore the answers, see who gets cited, and find your next improvement.` : 'Ask the questions your customers ask. See when your brand appears, who gets recommended instead and what you can improve.'}</p>
      <button className="summary-action" onClick={collected ? onAnswers : onCheck}>{collected ? 'Explore your answers' : 'Check your AI visibility'}<ArrowRight size={16} /></button>
    </div>
    <div className="overview-summary-visual">{collected ? <><CoverageRing count={cited} total={collected} label="collected answers cite your website" /><span><Link size={15} /> Website citations</span></> : <><MessagesSquare size={48} strokeWidth={1.5} /><strong>Get discovered</strong><span>Your brand in AI search</span></>}</div>
  </section>;
}
