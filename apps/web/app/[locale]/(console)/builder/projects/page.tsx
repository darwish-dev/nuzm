import { ProjectsScreen } from '../../../../../lib/builder-projects-screen';

/** UI-M09-01/02: start a project and the list of every project type. */
export default function Projects(p: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <ProjectsScreen params={p.params} searchParams={p.searchParams} />;
}
