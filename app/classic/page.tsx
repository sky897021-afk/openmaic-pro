import { HomePage } from '@/components/home/home-page';

/**
 * Mode ① — a full course: teaching segments plus classroom interaction and a
 * teacher-student mini-game.
 *
 * Each mode has its own route so the three entry links handed out to other
 * sites land straight in the right one, and so the address bar always says
 * which mode the next submission will run in.
 */
export default function ClassicPage() {
  return <HomePage mode="classic" />;
}
