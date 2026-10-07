import {
  ATS_IDS,
  adapterToggleSchema,
  companyBoardRemovedSchema,
  companyBoardSchema,
  savedPlaceRemovedSchema,
  savedPlaceSchema,
  budgetUpdatedSchema,
  dataClearedSchema,
  restartSchema,
  type AdapterToggle,
  type Budget,
  type CompanyBoard,
  type SavedPlace,
  type DataCleared,
} from '@jobwatch/dashboard-api';
import { BUDGET_MAX, BUDGET_MIN, type EngineLogger } from '@jobwatch/core';
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

/** The only things the dashboard can change. None touches a third-party platform. */
export interface Changes {
  /** Turn an adapter on or off and reload the registry (hot reload). */
  setAdapter(id: string, enabled: boolean): Promise<Omit<AdapterToggle, 'id' | 'enabled' | 'reconnectNeeded'>>;
  /** Forget the jobs and searches an adapter stored, so its next call starts fresh. Usage and budgets are left alone. */
  clearData(id: string): Promise<Omit<DataCleared, 'id'>>;
  /** Save the request budget of an adapter or utility (the windows not set by the environment). Applies to the next call. */
  setBudget(id: string, change: { hourly?: number; daily?: number }): Promise<Budget>;
  /** Map a company to its board on an ATS. Refused (409) when the company already has a board on that ATS. */
  addCompanyBoard(entry: { company: string; ats: string; handle: string }): CompanyBoard;
  /** Forget a mapping. False when there was none. */
  removeCompanyBoard(id: number): boolean;
  /** Remember a name for a LinkedIn place (replaces what the name stood for, a lookup's guess or an older choice). */
  savePlace(entry: { alias: string; id: string; label: string }): Promise<SavedPlace>;
  /** Forget a remembered name. False when there was none. */
  forgetPlace(alias: string): Promise<boolean>;
  /** Number of calls still running. */
  running(): number;
  /** Stop the router process so the container's restart policy brings it back. */
  restart(): void;
}

const adapterId = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/);
const toggleBody = z.object({ enabled: z.boolean() }).strict();
const budgetAmount = z.number().int().min(BUDGET_MIN).max(BUDGET_MAX);
const budgetBody = z
  .object({ hourly: budgetAmount.optional(), daily: budgetAmount.optional() })
  .strict()
  .refine((body) => body.hourly !== undefined || body.daily !== undefined, { message: 'send hourly, daily or both' });
const companyBoardBody = z
  .object({
    company: z.string().trim().min(1).max(120),
    ats: z.enum(ATS_IDS),
    // a Teamtailor handle is a subdomain: lower case only
    handle: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/),
  })
  .strict()
  .refine((body) => body.ats !== 'teamtailor' || body.handle === body.handle.toLowerCase(), {
    message: 'a Teamtailor handle is lower case',
    path: ['handle'],
  });
const placeBody = z
  .object({
    alias: z.string().trim().min(2).max(60),
    id: z.string().regex(/^\d{3,12}$/, 'a numeric LinkedIn geoId'),
    label: z.string().trim().max(200).default(''),
  })
  .strict();
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

  router.put('/adapters/:id/budget', async (req, res, next) => {
    try {
      const id = adapterId.parse(req.params['id']);
      const change = budgetBody.parse(req.body);
      const budget = await changes.setBudget(id, change);
      logger.info({ actor: actor(res), adapter: id, ...change }, 'dashboard_budget_changed');
      res.json(checked(budgetUpdatedSchema, { id, budget }));
    } catch (error) {
      if (error instanceof ChangeRefused) return refuse(res, error);
      next(error);
    }
  });

  router.delete('/adapters/:id/data', async (req, res, next) => {
    try {
      const id = adapterId.parse(req.params['id']);
      const result = await changes.clearData(id);
      logger.info({ actor: actor(res), adapter: id, ...result }, 'dashboard_data_cleared');
      res.json(checked(dataClearedSchema, { id, ...result }));
    } catch (error) {
      if (error instanceof ChangeRefused) return refuse(res, error);
      next(error);
    }
  });

  router.post('/company-boards', (req, res, next) => {
    try {
      const entry = companyBoardBody.parse(req.body);
      const board = changes.addCompanyBoard(entry);
      logger.info({ actor: actor(res), company: board.company, ats: board.ats, handle: board.handle }, 'dashboard_company_board_added');
      res.status(201).json(checked(companyBoardSchema, board));
    } catch (error) {
      if (error instanceof ChangeRefused) return refuse(res, error);
      next(error);
    }
  });

  router.delete('/company-boards/:id', (req, res, next) => {
    try {
      const id = z.coerce.number().int().min(1).parse(req.params['id']);
      if (!changes.removeCompanyBoard(id)) return refuse(res, new ChangeRefused(404, 'not_found', 'That mapping no longer exists.'));
      logger.info({ actor: actor(res), id }, 'dashboard_company_board_removed');
      res.json(checked(companyBoardRemovedSchema, { id }));
    } catch (error) {
      next(error);
    }
  });

  router.post('/places', async (req, res, next) => {
    try {
      const entry = placeBody.parse(req.body);
      const place = await changes.savePlace({ ...entry, label: entry.label === '' ? entry.alias : entry.label });
      logger.info({ actor: actor(res), alias: place.alias, id: place.id }, 'dashboard_place_saved');
      res.status(201).json(checked(savedPlaceSchema, place));
    } catch (error) {
      if (error instanceof ChangeRefused) return refuse(res, error);
      next(error);
    }
  });

  router.delete('/places/:alias', async (req, res, next) => {
    try {
      const alias = z.string().trim().min(2).max(100).parse(req.params['alias']);
      if (!(await changes.forgetPlace(alias))) return refuse(res, new ChangeRefused(404, 'not_found', 'That name is not remembered.'));
      logger.info({ actor: actor(res), alias }, 'dashboard_place_forgotten');
      res.json(checked(savedPlaceRemovedSchema, { alias }));
    } catch (error) {
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
