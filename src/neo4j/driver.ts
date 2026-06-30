import neo4j, { type Driver, type Session } from 'neo4j-driver';
import { config } from '../config.ts';

let _driver: Driver | null = null;

export function getDriver(): Driver {
  if (_driver) return _driver;
  _driver = neo4j.driver(
    config.neo4j.uri,
    neo4j.auth.basic(config.neo4j.user, config.neo4j.password),
    { disableLosslessIntegers: true },
  );
  return _driver;
}

export function getSession(): Session {
  return getDriver().session({ database: config.neo4j.database });
}

export async function closeDriver(): Promise<void> {
  if (_driver) {
    await _driver.close();
    _driver = null;
  }
}

export async function withSession<T>(fn: (s: Session) => Promise<T>): Promise<T> {
  const s = getSession();
  try {
    return await fn(s);
  } finally {
    await s.close();
  }
}
