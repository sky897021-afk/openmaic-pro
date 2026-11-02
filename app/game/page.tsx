import { HomePage } from '@/components/home/home-page';
import { HandoffLanding } from '@/components/integration/HandoffLanding';

/**
 * Mode ② — one page, whatever the material: a single teaching mini-game that
 * walks the whole lesson.
 *
 * `?handoff=<id>` is the module-2 platform handoff: the landing reads the
 * uploaded materials and seeds this same single-game generation session.
 *
 * See `app/classic/page.tsx` for why each mode owns a route.
 */
export default async function SingleGamePage({
  searchParams,
}: {
  searchParams: Promise<{ handoff?: string | string[] }>;
}) {
  const params = await searchParams;
  const handoff = Array.isArray(params.handoff) ? params.handoff[0] : params.handoff;
  if (handoff) return <HandoffLanding handoffId={handoff} />;
  return <HomePage mode="single-game" />;
}
