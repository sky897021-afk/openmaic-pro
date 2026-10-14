import { HomePage } from '@/components/home/home-page';

/**
 * Mode ② — one page, whatever the material: a single teaching mini-game that
 * walks the whole lesson.
 *
 * See `app/classic/page.tsx` for why each mode owns a route.
 */
export default function SingleGamePage() {
  return <HomePage mode="single-game" />;
}
