import collection from '../../../../../lib/api-docs/postman.json';

/** The Postman collection of the public integration surface (generated from the platform contract by `pnpm docs:generate`). */
export function GET() {
  return new Response(JSON.stringify(collection), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': 'attachment; filename="nuzm-postman-collection.json"',
      'cache-control': 'public, max-age=300',
    },
  });
}
