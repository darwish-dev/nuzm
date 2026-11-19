import { redirectToWorkspace } from '../../../../../../lib/mobile-view';

/** The former builds page: the Builds panel of the workspace. Kept as a redirect so existing links keep working. */
export default function Page({ params }: { params: Promise<{ locale: string; id: string }> }) {
  return redirectToWorkspace(params, 'builds');
}
