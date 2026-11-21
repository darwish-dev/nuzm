// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';

const post = vi.fn();
vi.mock('../lib/client', () => ({ browserApi: () => ({ POST: post }) }));
import {
  ChangePasswordForm,
  ForgotForm,
  LoginForm,
  RegisterForm,
  ResetForm,
  VerifyEmail,
} from './AuthForms';

const res = (status: number, error?: unknown) => ({
  response: { ok: status >= 200 && status < 300, status },
  ...(error ? { error } : {}),
});
const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const assign = vi.fn();
beforeEach(() => {
  post.mockReset();
  assign.mockReset();
  Object.defineProperty(window, 'location', {
    value: { assign, reload: vi.fn() },
    writable: true,
  });
});
afterEach(cleanup);

describe('login form', () => {
  it('signs in and goes to the safe next path', async () => {
    post.mockResolvedValue(res(200));
    render(<LoginForm locale="en" next="/billing" />);
    type(t('en', 'field.email'), 'a@example.test');
    type(t('en', 'field.password'), 'a long passphrase 2026');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'action.signin') }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/billing'));
    expect(post).toHaveBeenCalledWith('/v1/auth/password/login', {
      body: { email: 'a@example.test', password: 'a long passphrase 2026' },
    });
  });

  it('never follows an off-site next path', async () => {
    post.mockResolvedValue(res(200));
    render(<LoginForm locale="ar" next="//evil.example/x" />);
    type(t('ar', 'field.email'), 'a@example.test');
    type(t('ar', 'field.password'), 'a long passphrase 2026');
    fireEvent.click(screen.getByRole('button', { name: t('ar', 'action.signin') }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/console'));
  });

  it('shows one message for a wrong email or password, and a different one when rate limited', async () => {
    post.mockResolvedValueOnce(res(401));
    render(<LoginForm locale="en" />);
    type(t('en', 'field.email'), 'a@example.test');
    type(t('en', 'field.password'), 'whatever password');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'action.signin') }));
    expect((await screen.findByRole('alert')).textContent).toBe(t('en', 'login.invalid'));
    post.mockResolvedValueOnce(res(429));
    fireEvent.click(screen.getByRole('button', { name: t('en', 'action.signin') }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(t('en', 'login.rate')));
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('register form', () => {
  const fill = (email: string, pw: string) => {
    type(t('en', 'field.email'), email);
    type(t('en', 'field.password'), pw);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'register.submit') }));
  };

  it('checks the password before calling the API', async () => {
    render(<RegisterForm locale="en" />);
    fill('a@example.test', 'short');
    expect(await screen.findByText(t('en', 'password.err.too_short'))).toBeTruthy();
    fill('a@example.test', 'a@example.test');
    expect(await screen.findByText(t('en', 'password.err.same_as_email'))).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it('creates the account and continues to organization setup', async () => {
    post.mockResolvedValue(res(201));
    render(<RegisterForm locale="en" />);
    fill('a@example.test', 'a long passphrase 2026');
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/orgs/new'));
    expect(post.mock.calls[0]![1]).toEqual({
      body: { email: 'a@example.test', password: 'a long passphrase 2026', locale: 'en' },
    });
  });

  it('explains an existing email and a weak password from the server', async () => {
    post.mockResolvedValueOnce(res(409, { code: 'email_in_use' }));
    render(<RegisterForm locale="en" />);
    fill('a@example.test', 'a long passphrase 2026');
    expect(await screen.findByText(t('en', 'register.exists'))).toBeTruthy();
    post.mockResolvedValueOnce(res(422, { code: 'weak_password' }));
    fill('b@example.test', 'a long passphrase 2026');
    expect(await screen.findByText(t('en', 'password.err.weak'))).toBeTruthy();
  });
});

describe('forgot and reset', () => {
  it('forgot always ends in the same neutral message', async () => {
    post.mockResolvedValue(res(202));
    render(<ForgotForm locale="en" />);
    type(t('en', 'field.email'), 'nobody@example.test');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'forgot.submit') }));
    expect(await screen.findByText(t('en', 'forgot.done'))).toBeTruthy();
  });

  it('reset sends the token, then offers sign-in; an invalid token is explained', async () => {
    post.mockResolvedValueOnce(res(400, { code: 'invalid_token' }));
    render(<ResetForm locale="en" token="nzt_abc" />);
    type(t('en', 'field.passwordNew'), 'a brand new passphrase 77');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'reset.submit') }));
    expect(await screen.findByText(t('en', 'reset.invalid'))).toBeTruthy();
    post.mockResolvedValueOnce(res(204));
    fireEvent.click(screen.getByRole('button', { name: t('en', 'reset.submit') }));
    expect(await screen.findByText(t('en', 'reset.done'))).toBeTruthy();
    expect(post).toHaveBeenLastCalledWith('/v1/auth/password/reset', {
      body: { token: 'nzt_abc', newPassword: 'a brand new passphrase 77' },
    });
  });
});

describe('verify email', () => {
  it('confirms once on load', async () => {
    post.mockResolvedValue(res(204));
    render(<VerifyEmail locale="en" token="nzt_abc" />);
    expect(await screen.findByText(t('en', 'verify.done'))).toBeTruthy();
    expect(post).toHaveBeenCalledTimes(1);
  });
  it('says so when the link is no good', async () => {
    post.mockResolvedValue(res(400, { code: 'invalid_token' }));
    render(<VerifyEmail locale="ar" token="nzt_abc" />);
    expect(await screen.findByText(t('ar', 'verify.invalid'))).toBeTruthy();
  });
});

describe('change password', () => {
  it('maps a wrong current password and confirms success', async () => {
    post.mockResolvedValueOnce(res(401, { code: 'invalid_credentials' }));
    render(<ChangePasswordForm locale="en" email="a@example.test" />);
    type(t('en', 'field.passwordCurrent'), 'nope nope nope');
    type(t('en', 'field.passwordNew'), 'changed passphrase 4242');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'pw.change.submit') }));
    expect(await screen.findByText(t('en', 'pw.change.wrong'))).toBeTruthy();
    post.mockResolvedValueOnce(res(204));
    fireEvent.click(screen.getByRole('button', { name: t('en', 'pw.change.submit') }));
    expect(await screen.findByText(t('en', 'pw.change.done'))).toBeTruthy();
  });
});
