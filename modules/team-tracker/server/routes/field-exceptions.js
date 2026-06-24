/**
 * Field exception routes for team-tracker.
 * CRUD for per-field exceptions that exclude specific fields from completeness checks.
 */

const fieldExceptionsStore = require('../field-exceptions-store');

module.exports = function registerFieldExceptionRoutes(router, context) {
  const { storage, requireTeamAdmin, requireScope } = context;
  const { readFromStorage } = storage;

  const DEMO_MODE = process.env.DEMO_MODE === 'true';

  function demoWriteGuard(res) {
    if (DEMO_MODE) {
      return res.json({ demo: true, message: 'Demo mode — changes are not saved' });
    }
    return null;
  }

  // ─── Permission-based filtering ───

  function filterExceptionsForUser(exceptions, req) {
    if (req.isAdmin || req.isTeamAdmin) return exceptions;
    if (!req.isAdmin && !req.isTeamAdmin && !req.isManager) return [];

    // Manager: filter to managed people and purview teams
    const permissions = require('../../../../shared/server/permissions');
    const { getManagerPurview } = require('../manager-purview');

    const registry = readFromStorage('team-data/registry.json');
    if (!registry) return [];

    const teamStore = require('../../../../shared/server/team-store');
    const teamsData = teamStore.readTeams(storage);

    const managedUids = permissions.getManagedUids(req.userUid, permissions.buildManagerMap(registry));
    const purview = getManagerPurview(req.userUid, registry, teamsData, { includeIndirect: false });
    const purviewTeamIds = new Set(purview.teams.map(t => t.id));

    return exceptions.filter(ex => {
      if (ex.entityType === 'person') return managedUids.has(ex.entityId);
      if (ex.entityType === 'team') return purviewTeamIds.has(ex.entityId);
      return false;
    });
  }

  // ─── GET /field-exceptions ───

  /**
   * @openapi
   * /api/modules/team-tracker/field-exceptions:
   *   get:
   *     tags: ['TT: Field Exceptions']
   *     summary: List field exceptions with optional filters
   *     parameters:
   *       - name: entityType
   *         in: query
   *         schema:
   *           type: string
   *           enum: [person, team]
   *       - name: entityId
   *         in: query
   *         schema:
   *           type: string
   *       - name: fieldId
   *         in: query
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Filtered exceptions list
   */
  router.get('/field-exceptions', requireScope('roster:read'), function(req, res) {
    const filters = {};
    if (req.query.entityType) filters.entityType = req.query.entityType;
    if (req.query.entityId) filters.entityId = req.query.entityId;
    if (req.query.fieldId) filters.fieldId = req.query.fieldId;

    let exceptions = fieldExceptionsStore.listExceptions(storage, filters);
    exceptions = filterExceptionsForUser(exceptions, req);

    res.json({ exceptions });
  });

  // ─── POST /field-exceptions ───

  /**
   * @openapi
   * /api/modules/team-tracker/field-exceptions:
   *   post:
   *     tags: ['TT: Field Exceptions']
   *     summary: Create a field exception
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [entityType, entityId, fieldId, reason]
   *             properties:
   *               entityType:
   *                 type: string
   *                 enum: [person, team]
   *               entityId:
   *                 type: string
   *               fieldId:
   *                 type: string
   *               reason:
   *                 type: string
   *                 maxLength: 500
   *     responses:
   *       201:
   *         description: Exception created
   *       200:
   *         description: Exception updated (duplicate tuple)
   *       400:
   *         description: Validation error
   *       403:
   *         description: Not team-admin or admin
   */
  router.post('/field-exceptions', requireTeamAdmin, requireScope('team-tracker:write'), function(req, res) {
    const guarded = demoWriteGuard(res);
    if (guarded) return;

    const { entityType, entityId, fieldId, reason } = req.body;

    // Validate entityType
    if (!entityType || !['person', 'team'].includes(entityType)) {
      return res.status(400).json({ error: 'entityType must be "person" or "team"' });
    }

    // Validate entityId
    if (!entityId || typeof entityId !== 'string') {
      return res.status(400).json({ error: 'entityId is required' });
    }

    // Validate reason
    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      return res.status(400).json({ error: 'reason is required' });
    }
    if (reason.length > 500) {
      return res.status(400).json({ error: 'reason must be 500 characters or fewer' });
    }

    // Validate fieldId
    if (!fieldId || typeof fieldId !== 'string') {
      return res.status(400).json({ error: 'fieldId is required' });
    }

    // Validate __boards__ sentinel
    if (fieldId === '__boards__' && entityType !== 'team') {
      return res.status(400).json({ error: '__boards__ is only valid with entityType "team"' });
    }

    // Validate entity exists
    if (entityType === 'person') {
      const registry = readFromStorage('team-data/registry.json');
      if (!registry || !registry.people || !registry.people[entityId]) {
        return res.status(400).json({ error: `Person "${entityId}" not found in registry` });
      }
    } else {
      const teamStore = require('../../../../shared/server/team-store');
      const teamsData = teamStore.readTeams(storage);
      if (!teamsData || !teamsData.teams || !teamsData.teams[entityId]) {
        return res.status(400).json({ error: `Team "${entityId}" not found` });
      }
    }

    // Validate fieldId exists and is not deleted (skip for __boards__ sentinel)
    if (fieldId !== '__boards__') {
      const fieldStore = require('../../../../shared/server/field-store');
      const fieldDefs = fieldStore.readFieldDefinitions(storage);
      const scope = entityType === 'person' ? 'personFields' : 'teamFields';
      const field = (fieldDefs[scope] || []).find(f => f.id === fieldId);
      if (!field) {
        return res.status(400).json({ error: `Field "${fieldId}" not found in ${entityType} field definitions` });
      }
      if (field.deleted) {
        return res.status(400).json({ error: `Field "${fieldId}" is deleted` });
      }
    }

    const actorEmail = req.userEmail || 'unknown';
    const { exception, created } = fieldExceptionsStore.createException(
      storage,
      { entityType, entityId, fieldId, reason: reason.trim() },
      actorEmail
    );

    res.status(created ? 201 : 200).json({ exception });
  });

  // ─── DELETE /field-exceptions/:id ───

  /**
   * @openapi
   * /api/modules/team-tracker/field-exceptions/{id}:
   *   delete:
   *     tags: ['TT: Field Exceptions']
   *     summary: Remove a field exception
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Exception removed
   *       404:
   *         description: Exception not found
   *       403:
   *         description: Not team-admin or admin
   */
  router.delete('/field-exceptions/:id', requireTeamAdmin, requireScope('team-tracker:write'), function(req, res) {
    const guarded = demoWriteGuard(res);
    if (guarded) return;

    const actorEmail = req.userEmail || 'unknown';
    const removed = fieldExceptionsStore.removeException(storage, req.params.id, actorEmail);

    if (!removed) {
      return res.status(404).json({ error: 'Exception not found' });
    }

    res.json({ removed: true });
  });
};
