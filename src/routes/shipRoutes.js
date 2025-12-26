// src/routes/shipRoutes.js
import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import {
  getAllShips,
  getShipById,
  createShip,
  updateShip,
  deleteShip,
} from '../controller/shipsController.js';

export const router = Router();

/**
 * @openapi
 * tags:
 *   - name: Ships
 *     description: Ship management (role-based access)
 */

router.use(requireAuth);

/**
 * @openapi
 * components:
 *   schemas:
 *     Ship:
 *       type: object
 *       properties:
 *         ship_id: { type: integer, example: 1 }
 *         ship_name: { type: string, example: "Yellow One" }
 *         imo_number: { type: string, example: "IMO2234568" }
 *         flag: { type: string, example: "India" }
 *         class: { type: string, example: "IRS" }
 *         owner: { type: string, example: "BlueWave Shipping Ltd" }
 *         validity: { type: string, format: date-time, example: "2026-10-14T18:30:00.000Z" }
 *         ship_type: { type: string, example: "Tanker" }
 *         capacity: { type: string, example: "150,000 DWT" }
 *         powered_by: { type: string, example: "Diesel" }
 *         company_id: { type: string, format: uuid, example: "002f6dad-7f5a-4962-a6b6-eaca609a8fa0" }
 *         created_at: { type: string, format: date-time }
 *         updated_at: { type: string, format: date-time }
 *
 *     ShipCreate:
 *       type: object
 *       required: [company_id, ship_name]
 *       properties:
 *         company_id: { type: string, format: uuid, example: "002f6dad-7f5a-4962-a6b6-eaca609a8fa0" }
 *         ship_name: { type: string, example: "Yellow One" }
 *         imo_number: { type: string, example: "IMO2234568" }
 *         flag: { type: string, example: "India" }
 *         class: { type: string, example: "IRS" }
 *         owner: { type: string, example: "BlueWave Shipping Ltd" }
 *         validity: { type: string, format: date-time, example: "2026-10-14T18:30:00.000Z" }
 *         ship_type: { type: string, example: "Tanker" }
 *         capacity: { type: string, example: "150,000 DWT" }
 *         powered_by: { type: string, example: "Diesel" }
 *
 *     ShipUpdate:
 *       type: object
 *       additionalProperties: false
 *       properties:
 *         ship_name: { type: string, example: "Yellow One (Updated)" }
 *         imo_number: { type: string, example: "IMO2234569" }
 *         flag: { type: string, example: "India" }
 *         class: { type: string, example: "IRS" }
 *         owner: { type: string, example: "BlueWave Shipping Ltd" }
 *         validity: { type: string, format: date-time, example: "2027-10-14T18:30:00.000Z" }
 *         ship_type: { type: string, example: "Tanker" }
 *         capacity: { type: string, example: "160,000 DWT" }
 *         powered_by: { type: string, example: "Diesel" }
 *         company_id:
 *           type: string
 *           format: uuid
 *           description: "Role 1 can move ship to another company. Role 2 cannot."
 *           example: "002f6dad-7f5a-4962-a6b6-eaca609a8fa0"
 */

/**
 * @openapi
 * /ships:
 *   get:
 *     summary: Get ships (role-based)
 *     description: |
 *       - Role 1 (SuperAdmin): all ships
 *       - Role 2 (Admin): ships in own company
 *       - Role 3/4: only own ship (from token ship_id), otherwise []
 *     tags: [Ships]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of ships (may be empty)
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Ship'
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
router.get('/', getAllShips);

/**
 * @openapi
 * /ships/{id}:
 *   get:
 *     summary: Get ship by ID (role-based)
 *     description: |
 *       - Role 1: any ship
 *       - Role 2: only ships in own company
 *       - Role 3/4: only their own ship_id
 *     tags: [Ships]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: Ship ID
 *     responses:
 *       200:
 *         description: Ship details
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Ship'
 *       400:
 *         description: Invalid ship_id
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Ship not found
 *       500:
 *         description: Server error
 */
router.get('/:id', getShipById);

/**
 * @openapi
 * /ships:
 *   post:
 *     summary: Create ship (Role 1/2 only)
 *     description: |
 *       - Role 1: can create for any company_id
 *       - Role 2: can create only inside their own company_id (company scope enforced)
 *     tags: [Ships]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ShipCreate'
 *     responses:
 *       201:
 *         description: Created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Ship'
 *       400:
 *         description: company_id and ship_name are required / invalid input
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden (role or company scope)
 *       409:
 *         description: Duplicate IMO number (uq_ships_imo_number)
 *       500:
 *         description: Server error
 */
router.post('/', createShip);

/**
 * @openapi
 * /ships/{id}:
 *   put:
 *     summary: Update ship (Role 1/2 only)
 *     description: |
 *       - Role 1: can update any ship
 *       - Role 2: can update only ships in their company
 *       - Role 2 cannot move ship to a different company_id
 *     tags: [Ships]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: Ship ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ShipUpdate'
 *     responses:
 *       200:
 *         description: Updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string, example: "Ship updated" }
 *       400:
 *         description: Invalid ship_id
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden (role/company scope/cannot change company_id)
 *       404:
 *         description: Ship not found
 *       409:
 *         description: Duplicate IMO number (uq_ships_imo_number)
 *       500:
 *         description: Server error
 */
router.put('/:id', updateShip);

/**
 * @openapi
 * /ships/{id}:
 *   delete:
 *     summary: Delete ship (Role 1/2 only)
 *     description: |
 *       - Role 1: can delete any ship
 *       - Role 2: can delete only ships in their company
 *     tags: [Ships]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: Ship ID
 *     responses:
 *       200:
 *         description: Deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string, example: "Ship deleted" }
 *       400:
 *         description: Invalid ship_id
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden (role/company scope)
 *       404:
 *         description: Ship not found
 *       500:
 *         description: Server error
 */
router.delete('/:id', deleteShip);
