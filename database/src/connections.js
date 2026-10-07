/*
 * Copyright (C) 2026 ezTxmMC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of Lumen IDE. It is free software: you can redistribute it
 * and/or modify it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the License,
 * or (at your option) any later version. See the LICENSE file for details.
 */

/**
 * The saved connections, in two scopes: application-wide ones in the
 * extension's storage, project-wide ones in `.lumen/database-connections.json`
 * of the open folder (meant to be committed and shared). Passwords stay apart
 * in the system's key store (`ctx.secrets`), never in either document.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const TYPES = ['sqlite', 'h2', 'postgres', 'mysql', 'mssql', 'redis', 'mongo'];

/** Types that live in a file rather than on a server. */
export const FILE_TYPES = ['sqlite', 'h2'];
export const SQL_TYPES = ['sqlite', 'h2', 'postgres', 'mysql', 'mssql'];

export const DEFAULT_PORTS = { postgres: 5432, mysql: 3306, mssql: 1433, redis: 6379, mongo: 27017 };

export const TYPE_ICONS = {
  sqlite: 'database', h2: 'database', postgres: 'database', mysql: 'database', mssql: 'database', redis: 'layers', mongo: 'leaf',
};

/** File name endings and the type they open as. `.mv.db` must be checked before `.db`. */
const FILE_ENDINGS = [['.mv.db', 'h2'], ['.sqlite3', 'sqlite'], ['.sqlite', 'sqlite'], ['.db3', 'sqlite'], ['.db', 'sqlite']];

export function typeOfFile(file) {
  const lower = String(file).toLowerCase();
  return FILE_ENDINGS.find(([ending]) => lower.endsWith(ending))?.[1] ?? null;
}

/** A key for `ctx.secrets`: letters and digits only. */
export const secretKey = (id) => `pw${id}`;

export function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** What the tree shows under a connection's name. */
export function describe(connection) {
  if (FILE_TYPES.includes(connection.type)) {
    return connection.file ?? connection.url ?? '';
  }
  if (connection.url) {
    return redactUrl(connection.url);
  }
  const host = `${connection.host || 'localhost'}${connection.port ? `:${connection.port}` : ''}`;
  return connection.database ? `${host}/${connection.database}` : host;
}

/** A connection string without its password, for showing. */
export function redactUrl(url) {
  return String(url)
    .replace(/(\/\/[^:/@]+:)[^@/]*@/, '$1•••@')
    .replace(/((?:^|;)\s*(?:password|pwd)\s*=)[^;]*/gi, '$1•••');
}

/** Where a project's connections live, relative to the project folder. */
export const PROJECT_FILE = path.join('.lumen', 'database-connections.json');

const isConnection = (entry) => entry && TYPES.includes(entry.type) && typeof entry.id === 'string';

export function createConnections(ctx) {
  const listeners = new Set();
  const appList = () => ctx.storage.get('connections', []).filter(isConnection).map((entry) => ({ ...entry, scope: 'app' }));
  let app = appList();
  let project = [];
  let root = null;

  const projectFile = () => (root ? path.join(root, PROJECT_FILE) : null);

  function loadProject() {
    root = ctx.workspace.root() ?? null;
    const file = projectFile();
    project = [];
    if (!file) {
      return;
    }
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      project = (Array.isArray(data?.connections) ? data.connections : []).filter(isConnection).map((entry) => ({ ...entry, scope: 'project' }));
    } catch {
      // No file, or one that does not parse: no project connections.
    }
  }

  const notify = () => {
    for (const fn of listeners) {
      fn();
    }
  };

  const strip = ({ scope: _scope, ...rest }) => rest;

  async function save(scope) {
    if (scope === 'project') {
      const file = projectFile();
      if (!file) {
        throw new Error('No project folder is open.');
      }
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, `${JSON.stringify({ connections: project.map(strip) }, null, 2)}\n`, 'utf8');
      notify();
      return;
    }
    await ctx.storage.set('connections', app.map(strip));
    notify();
  }

  loadProject();
  ctx.workspace.onDidChange(() => {
    loadProject();
    notify();
  });

  const all = () => [...app, ...project];
  const find = (id) => all().find((entry) => entry.id === id) ?? null;

  return {
    list: all,
    get: find,
    hasProject: () => Boolean(root),
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /**
     * Add or replace. `password`: a string sets it, `''` removes it, `undefined`
     * keeps it. The connection is saved even when the key store refuses the
     * password — the error is thrown afterwards, for the caller to show.
     * `connection.scope` is `'app'` (default) or `'project'`; changing it moves
     * the connection from one list to the other.
     */
    async put(connection, password) {
      const scope = connection.scope === 'project' && root ? 'project' : 'app';
      const entry = { ...connection, id: connection.id || newId(), scope };
      const previous = find(entry.id);
      if (previous && previous.scope !== scope) {
        if (previous.scope === 'project') {
          project = project.filter((known) => known.id !== entry.id);
        }
        if (previous.scope === 'app') {
          app = app.filter((known) => known.id !== entry.id);
        }
        await save(previous.scope);
      }
      const replace = (list) => (list.some((known) => known.id === entry.id) ? list.map((known) => (known.id === entry.id ? entry : known)) : [...list, entry]);
      if (scope === 'project') {
        project = replace(project);
      }
      if (scope === 'app') {
        app = replace(app);
      }
      await save(scope);
      if (entry.savePassword === false) {
        await ctx.secrets.delete(secretKey(entry.id)).catch(() => {});
      }
      if (password !== undefined && entry.savePassword !== false) {
        await ctx.secrets.set(secretKey(entry.id), password);
      }
      return entry;
    },

    async remove(id) {
      const known = find(id);
      if (!known) {
        return;
      }
      app = app.filter((entry) => entry.id !== id);
      project = project.filter((entry) => entry.id !== id);
      await ctx.secrets.delete(secretKey(id)).catch(() => {});
      await save(known.scope);
    },

    password: async (id) => (await ctx.secrets.get(secretKey(id)).catch(() => undefined)) ?? '',

    /** The connection for a file — the one already saved, or a new one. */
    async forFile(file) {
      const known = all().find((entry) => entry.file === file);
      if (known) {
        return known;
      }
      const type = typeOfFile(file) ?? 'sqlite';
      const name = String(file).split(/[\\/]/).pop();
      return this.put({ type, name, file, scope: 'app', ...(type === 'h2' ? { user: 'sa' } : {}), savePassword: true });
    },
  };
}
