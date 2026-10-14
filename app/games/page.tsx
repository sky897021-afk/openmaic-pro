import { HomePage } from '@/components/home/home-page';

/**
 * Mode ③ — one game page per teaching objective: the more material, the more
 * pages.
 *
 * See `app/classic/page.tsx` for why each mode owns a route.
 */
export default function MultiGamePage() {
  return <HomePage mode="multi-game" />;
}
