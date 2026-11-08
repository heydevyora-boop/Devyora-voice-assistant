import { validateEnv } from '../src/config/env.validation';
import { buildConfiguration } from '../src/config/configuration';

const base = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db?schema=public',
};

describe('environment validation', () => {
  it('accepts a minimal valid environment and applies defaults', () => {
    const env = validateEnv({ ...base });
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.API_PREFIX).toBe('api');
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:5173']);
  });

  it('rejects a missing DATABASE_URL rather than starting without one', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
  });

  it('rejects a DATABASE_URL that is not PostgreSQL', () => {
    expect(() => validateEnv({ DATABASE_URL: 'mysql://localhost/db' })).toThrow(
      /must be a PostgreSQL connection string/,
    );
  });

  it('coerces PORT from a string and rejects an out-of-range value', () => {
    expect(validateEnv({ ...base, PORT: '8080' }).PORT).toBe(8080);
    expect(() => validateEnv({ ...base, PORT: '70000' })).toThrow(/PORT/);
  });

  it('parses CORS_ORIGINS into a trimmed list', () => {
    const env = validateEnv({ ...base, CORS_ORIGINS: 'https://a.test, https://b.test ' });
    expect(env.CORS_ORIGINS).toEqual(['https://a.test', 'https://b.test']);
  });

  it('refuses a wildcard CORS origin in production', () => {
    expect(() =>
      validateEnv({ ...base, NODE_ENV: 'production', CORS_ORIGINS: '*', LOG_PRETTY: 'false' }),
    ).toThrow(/not allowed in production/);
  });

  it('refuses pretty logging in production', () => {
    expect(() =>
      validateEnv({ ...base, NODE_ENV: 'production', LOG_PRETTY: 'true' }),
    ).toThrow(/pretty logs are not allowed in production/);
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => validateEnv({ ...base, NODE_ENV: 'prod' })).toThrow(/NODE_ENV/);
  });

  it('allows the secrets reserved for later chunks to be absent', () => {
    const env = validateEnv({ ...base });
    expect(env.JWT_ACCESS_SECRET).toBeUndefined();
    expect(env.REDIS_URL).toBeUndefined();
  });

  it('reports every problem at once, not just the first', () => {
    try {
      validateEnv({ PORT: 'abc', NODE_ENV: 'nope' });
      throw new Error('expected validation to fail');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/PORT/);
      expect(message).toMatch(/NODE_ENV/);
      expect(message).toMatch(/DATABASE_URL/);
    }
  });
});

describe('configuration document', () => {
  it('derives environment flags from NODE_ENV', () => {
    const config = buildConfiguration(validateEnv({ ...base, NODE_ENV: 'production', LOG_PRETTY: 'false' }));
    expect(config.app.isProduction).toBe(true);
    expect(config.app.isDevelopment).toBe(false);
  });

  it('groups provider settings under one namespace', () => {
    const config = buildConfiguration(validateEnv({ ...base, REDIS_URL: 'redis://localhost:6379' }));
    expect(config.providers.redisUrl).toBe('redis://localhost:6379');
    expect(config.providers.jwt.accessTtl).toBe('10m');
  });
});
