import { adapterToggleSchema, restartSchema, type AdapterToggle } from '@jobwatch/dashboard-api';
import type { EngineLogger } from '@jobwatch/core';
import express, { type Router } from 'express';
import { z } from 'zod';
import { checked } from './api';
import type { Session } from './sessions';

/** A change the router refuses, with the status and the short reason the dashboard shows. */
export class ChangeRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The only two things the dashboard can change. Neither touches a third-party platform. */
export interface Changes {
  /** Turn an adapter on or off and reload the registry (hot reload). */
  setAdapter(id: string, enabled: boolean): Promise<Omit<AdapterToggle, 'id' | 'enabled' | 'reconnectNeeded'>>;
  /** Number of calls still running. */
  running(): number;
  /** Stop the router process so the container's restart policy brings it back. */
  restart(): void;
}

const adapterId = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/);
const toggleBody = z.object({ enabled: z.boolean() }).strict();
const restartBody = z.object({ force: z.boolean().default(false) }).strict();

/**
 * The endpoints that change something (docs/plans/17-dashboard.md, sections 5 and 8). They are registered behind the CSRF header, the
 * Origin check and the recent-sign-in rule of the dashboard app, and every change is logged with who made it.
 */
export function registerWrites(router: Router, changes: Changes, logger: EngineLogger): void {
  router.use(express.json({ limit: '4kb' }));
  const actor = (res: express.Response): string => (res.locals['session'] as Session | undefined)?.email ?? 'unknown';
  const refuse = (res: express.Response, error: ChangeRefused): void =>
    void res.status(error.status).json({ error: error.code, message: error.message });

  router.put('/adapters/:id', async (req, res, next) => {
    try {
      const id = adapterId.parse(req.params['id']);
      const { enabled } = toggleBody.parse(req.body);
      const result = await changes.setAdapter(id, enabled);
      logger.info(
        { actor: actor(res), adapter: id, enabled, added: result.addedTools, removed: result.removedTools },
        'dashboard_adapter_changed',
      );
      res.json(checked(adapterToggleSchema, { id, enabled, ...result, reconnectNeeded: true }));
    } catch (error) {
      if (error instanceof ChangeRefused) return refuse(res, error);
      next(error);
    }
  });

  router.post('/router/restart', (req, res, next) => {
    try {
      const { force } = restartBody.parse(req.body ?? {});
      const running = changes.running();
      if (running > 0 && !force)
        return refuse(
          res,
          new ChangeRefused(
            409,
            'busy',
            `${running} call${running === 1 ? ' is' : 's are'} still running. Restarting would cut ${running === 1 ? 'it' : 'them'}.`,
          ),
        );
      logger.warn({ actor: actor(res), running, force }, 'dashboard_restart_requested');
      res.json(checked(restartSchema, { restarting: true }));
      // after the answer is on its way
      setTimeout(() => changes.restart(), 400).unref();
    } catch (error) {
      next(error);
    }
  });
}
