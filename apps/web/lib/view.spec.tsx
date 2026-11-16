// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '@nuzm/sdk';
import { view } from './view';

afterEach(cleanup);
const show = async (load: () => Promise<string>) => {
  const node = await view('en', load, (d) => <p>{d}</p>);
  return render(<div>{node}</div>);
};

describe('view(): every data screen renders data or an explicit state, never a blank page', () => {
  it('renders data on success', async () => {
    expect((await show(async () => 'hello')).getByText('hello')).toBeTruthy();
  });
  it('403 → forbidden panel', async () => {
    const r = await show(async () => {
      throw new ApiError(403, 'forbidden', undefined, undefined, undefined);
    });
    expect(r.getByRole('alert').textContent).toContain('You do not have access');
  });
  it('suspended organization → its own panel (not the generic error)', async () => {
    const r = await show(async () => {
      throw new ApiError(403, 'org_suspended', undefined, undefined, undefined);
    });
    expect(r.getByRole('alert').textContent).toContain('Organization suspended');
  });
  it('other API errors → error panel with the trace id for support', async () => {
    const r = await show(async () => {
      throw new ApiError(500, 'internal_error', undefined, 'abc123', undefined);
    });
    expect(r.getByRole('alert').textContent).toContain('Could not load this data');
    expect(r.getByRole('alert').textContent).toContain('abc123');
  });
  it('Arabic locale renders Arabic copy', async () => {
    const node = await view(
      'ar',
      async () => {
        throw new ApiError(403, 'forbidden', undefined, undefined, undefined);
      },
      () => null,
    );
    expect(render(<div>{node}</div>).getByRole('alert').textContent).toContain(
      'لا تملك صلاحية الوصول',
    );
  });
});
