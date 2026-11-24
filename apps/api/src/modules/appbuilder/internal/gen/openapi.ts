import type { ResolvedAuth } from './options';
import type { AppSpec, EntitySpec, FieldSpec } from '../spec/app-spec';

type Json = Record<string, unknown>;

function fieldSchema(f: FieldSpec): Json {
  switch (f.type) {
    case 'string':
    case 'text':
      return { type: 'string', maxLength: f.maxLength ?? (f.type === 'string' ? 255 : 20000) };
    case 'integer':
      return {
        type: 'integer',
        ...(f.min !== undefined ? { minimum: f.min } : {}),
        ...(f.max !== undefined ? { maximum: f.max } : {}),
      };
    case 'decimal':
      return {
        type: 'number',
        ...(f.min !== undefined ? { minimum: f.min } : {}),
        ...(f.max !== undefined ? { maximum: f.max } : {}),
      };
    case 'boolean':
      return { type: 'boolean' };
    case 'date':
      return { type: 'string', format: 'date' };
    case 'datetime':
      return { type: 'string', format: 'date-time' };
    case 'enum':
      return { type: 'string', enum: f.enumValues };
    case 'email':
      return { type: 'string', format: 'email', maxLength: 254 };
    case 'phone':
      return { type: 'string', maxLength: 32 };
    case 'url':
      return { type: 'string', format: 'uri', maxLength: 2048 };
    case 'reference':
      return { type: 'string', format: 'uuid' };
    case 'file':
      return {
        type: 'object',
        properties: {
          name: { type: 'string' },
          mime: { type: 'string' },
          size: { type: 'integer' },
        },
      };
  }
}
const inputFileSchema: Json = {
  type: 'object',
  required: ['name', 'contentBase64'],
  properties: {
    name: { type: 'string' },
    mime: { type: 'string' },
    contentBase64: { type: 'string', format: 'byte' },
  },
};

const problem = { $ref: '#/components/responses/Problem' };
const errs = (...codes: string[]) => Object.fromEntries(codes.map((c) => [c, problem]));
const auth = [{ bearerAuth: [] }];

/** OpenAPI 3.1 document of the GENERATED application (S43.2). It is linted with the same Spectral ruleset as the Nuzm API (spec/openapi/.spectral.yaml), and the contract tests are generated from it. */
export function generateOpenApi(
  spec: AppSpec,
  auth2: ResolvedAuth = { signupRole: null, tenancy: 'single' },
): Json {
  const base = spec.api.basePath;
  const paths: Record<string, Json> = {};
  const schemas: Record<string, Json> = {
    Problem: {
      type: 'object',
      required: ['status', 'code'],
      properties: {
        type: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'integer' },
        code: { type: 'string' },
        detail: { type: 'string' },
        errors: {
          type: 'array',
          items: {
            type: 'object',
            properties: { field: { type: 'string' }, message: { type: 'string' } },
          },
        },
      },
    },
    SessionUser: {
      type: 'object',
      required: ['id', 'email', 'name', 'role'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        email: { type: 'string', format: 'email' },
        name: { type: 'string' },
        role: { type: 'string', enum: spec.roles.map((r) => r.name) },
        teamId: { type: ['string', 'null'], format: 'uuid' },
        ...(auth2.tenancy === 'multi' ? { tenantId: { type: 'string', format: 'uuid' } } : {}),
        locale: { type: 'string', enum: ['ar', 'en'] },
      },
    },
  };
  const listParams = (e: EntitySpec) => [
    {
      name: 'search',
      in: 'query',
      schema: { type: 'string', maxLength: 100 },
      description: `Case-insensitive match on ${e.searchable.join(', ') || 'no field'}`,
    },
    {
      name: 'sort',
      in: 'query',
      schema: { type: 'string' },
      description: `field:asc|desc; one of ${[...e.sortable, 'createdAt', 'updatedAt'].join(', ')}`,
    },
    {
      name: 'limit',
      in: 'query',
      schema: {
        type: 'integer',
        minimum: 1,
        maximum: spec.api.maxLimit,
        default: spec.api.defaultLimit,
      },
    },
    { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
  ];
  const idParam = {
    name: 'id',
    in: 'path',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  };
  const role = (e: EntitySpec, a: string) =>
    spec.roles
      .filter((r) => (r.permissions[e.name] ?? []).includes(a as never))
      .map((r) => r.name)
      .join(', ') || 'none';

  paths['/health'] = {
    get: {
      operationId: 'health',
      tags: ['system'],
      summary: 'Health check',
      description: 'Returns 200 when the process is up. Used by the deployment health gate.',
      security: [],
      responses: {
        '200': {
          description: 'Healthy',
          content: {
            'application/json': {
              schema: { type: 'object', properties: { status: { type: 'string' } } },
            },
          },
        },
      },
    },
  };
  paths[`${base}/auth/login`] = {
    post: {
      operationId: 'login',
      tags: ['auth'],
      summary: 'Sign in',
      description: 'Email and password. Five failures per minute and email are answered with 429.',
      security: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['email', 'password'],
              properties: {
                email: { type: 'string', format: 'email' },
                password: { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Signed in',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['token', 'user'],
                properties: {
                  token: { type: 'string' },
                  user: { $ref: '#/components/schemas/SessionUser' },
                },
              },
            },
          },
        },
        ...errs('401', '422', '429'),
      },
    },
  };
  if (auth2.signupRole)
    paths[`${base}/auth/signup`] = {
      post: {
        operationId: 'signup',
        tags: ['auth'],
        summary: 'Register',
        description:
          auth2.tenancy === 'multi'
            ? 'Creates an organisation and its first administrator and signs in. Twenty sign-ups per minute are accepted in total; further ones are answered with 429.'
            : 'Creates a user with a fixed, non-administrator role and signs in. Twenty sign-ups per minute are accepted in total; further ones are answered with 429. A role in the body is ignored.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required:
                  auth2.tenancy === 'multi'
                    ? ['email', 'name', 'password', 'organization']
                    : ['email', 'name', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  name: { type: 'string', maxLength: 120 },
                  password: { type: 'string', minLength: 10, maxLength: 200 },
                  locale: { type: 'string', enum: ['ar', 'en'] },
                  ...(auth2.tenancy === 'multi'
                    ? { organization: { type: 'string', maxLength: 120 } }
                    : {}),
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Registered and signed in',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['token', 'user'],
                  properties: {
                    token: { type: 'string' },
                    user: { $ref: '#/components/schemas/SessionUser' },
                  },
                },
              },
            },
          },
          ...errs('409', '422', '429'),
        },
      },
    };
  paths[`${base}/auth/me`] = {
    get: {
      operationId: 'me',
      tags: ['auth'],
      summary: 'Current user and permissions',
      description: 'The signed-in user and the actions the role may take per entity.',
      security: auth,
      responses: {
        '200': {
          description: 'The user',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  user: { $ref: '#/components/schemas/SessionUser' },
                  permissions: {
                    type: 'object',
                    additionalProperties: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
        ...errs('401'),
      },
    },
  };
  paths[`${base}/auth/logout`] = {
    post: {
      operationId: 'logout',
      tags: ['auth'],
      summary: 'Sign out',
      description:
        'The session is revoked on the server: the token is refused from now on. The client also discards it.',
      security: auth,
      responses: { '204': { description: 'Signed out' }, ...errs('401') },
    },
  };
  paths[`${base}/users`] = {
    get: {
      operationId: 'listUsers',
      tags: ['users'],
      summary: 'List users',
      description: 'Administrators see every user; others see their team.',
      security: auth,
      responses: {
        '200': {
          description: 'Users',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { items: { type: 'array', items: { type: 'object' } } },
              },
            },
          },
        },
        ...errs('401'),
      },
    },
    post: {
      operationId: 'createUser',
      tags: ['users'],
      summary: 'Create a user',
      description: 'Administrators only. Passwords are hashed with scrypt and never returned.',
      security: auth,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['email', 'name', 'role', 'password'],
              properties: {
                email: { type: 'string', format: 'email' },
                name: { type: 'string' },
                role: { type: 'string', enum: spec.roles.map((r) => r.name) },
                password: { type: 'string', minLength: 10 },
                teamId: { type: ['string', 'null'], format: 'uuid' },
                locale: { type: 'string', enum: ['ar', 'en'] },
              },
            },
          },
        },
      },
      responses: {
        '201': {
          description: 'Created',
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        ...errs('401', '403', '409', '422'),
      },
    },
  };
  paths[`${base}/dashboard`] = {
    get: {
      operationId: 'dashboard',
      tags: ['dashboard'],
      summary: 'Dashboard widgets',
      description:
        'Values of the dashboard widgets the role may see, computed within the role scope.',
      security: auth,
      responses: {
        '200': {
          description: 'Widgets',
          content: {
            'application/json': {
              schema: { type: 'object', properties: { widgets: { type: 'object' } } },
            },
          },
        },
        ...errs('401'),
      },
    },
  };

  for (const e of spec.entities) {
    const props: Record<string, Json> = Object.fromEntries(
      e.fields.map((f) => [f.name, fieldSchema(f)]),
    );
    const inputProps: Record<string, Json> = Object.fromEntries(
      e.fields.map((f) => [f.name, f.type === 'file' ? inputFileSchema : fieldSchema(f)]),
    );
    schemas[e.name] = {
      type: 'object',
      required: ['id', 'version', ...e.fields.filter((f) => f.required).map((f) => f.name)],
      properties: {
        id: { type: 'string', format: 'uuid' },
        ownerId: { type: ['string', 'null'], format: 'uuid' },
        teamId: { type: ['string', 'null'], format: 'uuid' },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
        version: { type: 'integer' },
        ...props,
      },
    };
    schemas[`${e.name}Input`] = {
      type: 'object',
      additionalProperties: false,
      required: e.fields.filter((f) => f.required).map((f) => f.name),
      properties: { ownerId: { type: 'string', format: 'uuid' }, ...inputProps },
    };
    schemas[`${e.name}Patch`] = {
      type: 'object',
      additionalProperties: false,
      properties: {
        ownerId: { type: 'string', format: 'uuid' },
        version: { type: 'integer' },
        ...inputProps,
      },
    };
    schemas[`${e.name}Page`] = {
      type: 'object',
      required: ['items', 'total', 'limit', 'offset'],
      properties: {
        items: { type: 'array', items: { $ref: `#/components/schemas/${e.name}` } },
        total: { type: 'integer' },
        limit: { type: 'integer' },
        offset: { type: 'integer' },
      },
    };
    const p = `${base}/${e.plural}`;
    const tag = e.plural;
    const filterNote = `Filters: filter.<field>=value (and .gte/.lte for numbers and dates) on ${e.fields
      .filter((f) => f.type !== 'file')
      .map((f) => f.name)
      .join(', ')}.`;
    paths[p] = {
      get: {
        operationId: `list${e.name}`,
        tags: [tag],
        summary: `List ${e.plural}`,
        description: `Rows visible to the caller (row-level scope of the role). Roles that may read: ${role(e, 'read')}. ${filterNote}`,
        security: auth,
        parameters: listParams(e),
        responses: {
          '200': {
            description: 'A page',
            content: {
              'application/json': { schema: { $ref: `#/components/schemas/${e.name}Page` } },
            },
          },
          ...errs('401', '403', '422'),
        },
      },
      post: {
        operationId: `create${e.name}`,
        tags: [tag],
        summary: `Create a ${e.name}`,
        description: `The caller becomes the owner unless ownerId names another user the role may assign to. Roles: ${role(e, 'create')}.`,
        security: auth,
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: `#/components/schemas/${e.name}Input` } },
          },
        },
        responses: {
          '201': {
            description: 'Created',
            headers: {
              ETag: { schema: { type: 'string' } },
              Location: { schema: { type: 'string' } },
            },
            content: { 'application/json': { schema: { $ref: `#/components/schemas/${e.name}` } } },
          },
          ...errs('401', '403', '409', '422'),
        },
      },
    };
    if (spec.nonFunctional.csvImportExport) {
      paths[`${p}/export.csv`] = {
        get: {
          operationId: `export${e.name}Csv`,
          tags: [tag],
          summary: `Export ${e.plural} as CSV`,
          description: `Same filters and scope as the list; up to 5000 rows. Cells that could be read as spreadsheet formulas are neutralised. Roles: ${role(e, 'export')}.`,
          security: auth,
          parameters: listParams(e),
          responses: {
            '200': { description: 'CSV', content: { 'text/csv': { schema: { type: 'string' } } } },
            ...errs('401', '403', '422'),
          },
        },
      };
      paths[`${p}/import`] = {
        post: {
          operationId: `import${e.name}Csv`,
          tags: [tag],
          summary: `Import ${e.plural} from CSV`,
          description: `Body is CSV text with a header row of field names. All rows are validated first; nothing is written unless every row is valid. dryRun=true only validates. Roles: ${role(e, 'import')}.`,
          security: auth,
          parameters: [{ name: 'dryRun', in: 'query', schema: { type: 'boolean' } }],
          requestBody: { required: true, content: { 'text/csv': { schema: { type: 'string' } } } },
          responses: {
            '200': {
              description: 'Imported',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      imported: { type: 'integer' },
                      dryRun: { type: 'boolean' },
                      accepted: { type: 'integer' },
                    },
                  },
                },
              },
            },
            ...errs('401', '403', '422'),
          },
        },
      };
    }
    if (e.stageField)
      paths[`${p}/board`] = {
        get: {
          operationId: `board${e.name}`,
          tags: [tag],
          summary: `Pipeline board of ${e.plural}`,
          description: `Rows grouped by ${e.stageField}, at most 50 per stage, within the caller's scope.`,
          security: auth,
          responses: {
            '200': {
              description: 'Board',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
            ...errs('401', '403', '404'),
          },
        },
      };
    paths[`${p}/{id}`] = {
      get: {
        operationId: `get${e.name}`,
        tags: [tag],
        summary: `Read a ${e.name}`,
        description:
          'A record outside the caller scope answers 404, never 403, so existence is not disclosed.',
        security: auth,
        parameters: [idParam],
        responses: {
          '200': {
            description: 'The record',
            headers: { ETag: { schema: { type: 'string' } } },
            content: { 'application/json': { schema: { $ref: `#/components/schemas/${e.name}` } } },
          },
          ...errs('401', '403', '404'),
        },
      },
      patch: {
        operationId: `update${e.name}`,
        tags: [tag],
        summary: `Update a ${e.name}`,
        description: `Send If-Match (or version in the body) for optimistic locking; a stale version answers 409. Roles: ${role(e, 'update')}.`,
        security: auth,
        parameters: [
          idParam,
          { name: 'If-Match', in: 'header', required: false, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: `#/components/schemas/${e.name}Patch` } },
          },
        },
        responses: {
          '200': {
            description: 'Updated',
            content: { 'application/json': { schema: { $ref: `#/components/schemas/${e.name}` } } },
          },
          ...errs('401', '403', '404', '409', '422'),
        },
      },
      delete: {
        operationId: `delete${e.name}`,
        tags: [tag],
        summary: `Delete a ${e.name}`,
        description: `A record that other records reference answers 409. Roles: ${role(e, 'delete')}.`,
        security: auth,
        parameters: [idParam],
        responses: { '204': { description: 'Deleted' }, ...errs('401', '403', '404', '409') },
      },
    };
    paths[`${p}/{id}/audit`] = {
      get: {
        operationId: `audit${e.name}`,
        tags: [tag],
        summary: `Change history of a ${e.name}`,
        description: 'Append-only audit trail of the record; personal fields are redacted.',
        security: auth,
        parameters: [idParam],
        responses: {
          '200': {
            description: 'Entries',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { items: { type: 'array', items: { type: 'object' } } },
                },
              },
            },
          },
          ...errs('401', '403', '404'),
        },
      },
    };
    for (const f of e.fields.filter((x) => x.type === 'file'))
      paths[`${p}/{id}/files/${f.name}`] = {
        get: {
          operationId: `download${e.name}${f.name[0]!.toUpperCase()}${f.name.slice(1)}`,
          tags: [tag],
          summary: `Download ${f.name} of a ${e.name}`,
          description: 'Always served as an attachment (application/octet-stream).',
          security: auth,
          parameters: [idParam],
          responses: {
            '200': {
              description: 'The file',
              content: {
                'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
              },
            },
            ...errs('401', '403', '404'),
          },
        },
      };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: `${spec.name} API`,
      version: '1.0.0',
      description: spec.description || `${spec.name} REST API, generated by the Nuzm app builder.`,
      license: { name: 'UNLICENSED' },
    },
    servers: [{ url: '/', description: 'This deployment' }],
    tags: [
      { name: 'system', description: 'Health' },
      { name: 'auth', description: 'Sign-in and session' },
      { name: 'users', description: 'User administration' },
      { name: 'dashboard', description: 'Dashboard widgets' },
      ...spec.entities.map((e) => ({ name: e.plural, description: `${e.name} records` })),
    ],
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
      responses: {
        Problem: {
          description: 'Error (RFC 9457 problem details)',
          content: {
            'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } },
          },
        },
      },
      schemas,
    },
  };
}
