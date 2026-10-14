import { HomePage } from '@/components/home/home-page';

/**
 * `/` is the legacy entry, kept as an alias for mode ①. The three modes have
 * their own routes (`/classic`, `/game`, `/games`) — those are the links handed
 * out — and this one exists only for the in-app "back home" navigations that
 * already point here.
 */
export default function Page() {
  return <HomePage mode="classic" />;
}
