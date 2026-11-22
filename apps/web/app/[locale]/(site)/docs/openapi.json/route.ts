import spec from '../../../../../lib/api-docs/openapi.public.json';

/** The standalone OpenAPI file of the public integration surface (generated from the platform contract by `pnpm docs:generate`). */
export function GET() {
  return new Response(JSON.stringify(spec), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': 'attachment; filename="nuzm-openapi.json"',
      'cache-control': 'public, max-age=300',
    },
  });
}
