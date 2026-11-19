import { ProjectsScreen } from '../../../../../lib/builder-projects-screen';

/** UI-M10-01: the App builder entry: start a web app from one prompt, and the organization's web apps. */
export default function Apps(p: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <ProjectsScreen params={p.params} searchParams={p.searchParams} fixed="webapp" />;
}
