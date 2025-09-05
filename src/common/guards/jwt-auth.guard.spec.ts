import { JwtAuthGuard } from './jwt-auth.guard';

// Smoke test: class exists and extends AuthGuard('jwt') behaviorally
// We can't easily assert inheritance, but we can instantiate and check handleRequest default passes user through.

describe('JwtAuthGuard', () => {
  it('can be instantiated and exposes default handleRequest', () => {
    const guard = new JwtAuthGuard();
    // handleRequest(err, user, info, context, status)
    const user = { id: 'u1' };
    const result = (
      guard as unknown as { handleRequest: (e: unknown, u: unknown) => unknown }
    ).handleRequest(null, user);
    expect(result).toBe(user);
  });
});
