/**
 * userHandlers.ts — google.script.run handlers for auth and user management.
 *
 * Covers: serverVerifyGoogleToken, serverCreateUser, serverUpdateUser,
 *         serverDeactivateUser, serverReactivateUser.
 */

import { ResultStatus } from '../types/enums';
import { ServerResponse, WithSession } from '../types/responses';
import { requireAdminOrFail, resolveUser } from '../middleware/authMiddleware';
import {
  sanitizePayload,
  sanitizeEmail,
  validateCreateUserPayload,
  validateUpdateUserPayload,
  requireString,
} from '../middleware/inputValidator';
import { verifyGoogleIdToken } from '../services/tokenService';
import { createSession } from '../services/sessionService';
import { createUser, deactivateUser, reactivateUser, updateUser, recordLogin } from '../services/userService';
import { appendAuditLog } from '../services/auditLogService';
import {
  notifyUserCreated,
  notifyUserRoleChanged,
  notifyUserStatusChanged,
  notifySecurityEvent,
} from '../services/emailService';
import { findByEmail as findUserByEmail } from '../services/userService';
import { AuditAction } from '../types/enums';

/* global Logger */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverVerifyGoogleToken(idToken: string): ServerResponse {
  try {
    const tokenResult = verifyGoogleIdToken(idToken);
    if (tokenResult.status !== ResultStatus.SUCCESS || !tokenResult.data) {
      Logger.log(`[serverVerifyGoogleToken] Token invalid: ${tokenResult.message}`);
      return { status: 'error', message: tokenResult.message };
    }

    const email = tokenResult.data.email;
    Logger.log(`[serverVerifyGoogleToken] Token valid for: ${email}`);

    const authResult = resolveUser(email);
    if (authResult.status !== ResultStatus.SUCCESS || !authResult.data) {
      Logger.log(`[serverVerifyGoogleToken] User lookup failed for ${email}: ${authResult.message}`);
      try {
        notifySecurityEvent(email, 'login_rejected_user_not_registered', {
          source: 'gis',
          authMessage: authResult.message,
        });
      } catch (emailErr) {
        Logger.log(`[serverVerifyGoogleToken] notifySecurityEvent failed (non-fatal): ${String(emailErr)}`);
      }
      return { status: 'error', message: authResult.message };
    }

    const sessionToken = createSession(email, authResult.data.role);
    Logger.log(`[serverVerifyGoogleToken] Session created for ${email} (${authResult.data.role})`);

    const warnings: string[] = [];
    try {
      recordLogin(email);
    } catch (loginErr) {
      const msg = `Login timestamp not recorded: ${String(loginErr)}`;
      Logger.log(`[serverVerifyGoogleToken] recordLogin failed (non-fatal): ${String(loginErr)}`);
      warnings.push(msg);
    }

    return {
      status: 'success',
      message: 'Authenticated',
      data: {
        sessionToken,
        email,
        role:   authResult.data.role,
        clubId: authResult.data.clubId,
      },
      ...(warnings.length > 0 && { warnings }),
    };
  } catch (err) {
    Logger.log(`[serverVerifyGoogleToken] Error: ${String(err)}`);
    return { status: 'error', message: `Authentication error: ${String(err)}` };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverCreateUser(
  payload: WithSession<{ email: string; firstName: string; lastName: string; role: string; clubId?: string }>
): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;

    const raw = sanitizePayload(payload as unknown as Record<string, unknown>);
    const validation = validateCreateUserPayload(raw);
    if (validation.status !== ResultStatus.SUCCESS || !validation.data) {
      return { status: 'error', message: validation.message, errors: validation.errors };
    }
    const input = validation.data;

    const result = createUser(input, auth.adminEmail);
    if (result.status === ResultStatus.SUCCESS && result.data) {
      appendAuditLog({
        actorEmail: auth.adminEmail, action: AuditAction.USER_CREATED,
        resourceType: 'user', resourceId: input.email,
        details: { email: input.email, clubId: input.clubId, role: input.role },
      });
      const warnings: string[] = [];
      try {
        notifyUserCreated(result.data, auth.adminEmail);
      } catch (emailErr) {
        const msg = `Welcome email could not be sent: ${String(emailErr)}`;
        Logger.log(`serverCreateUser: notifyUserCreated failed (non-fatal): ${String(emailErr)}`);
        warnings.push(msg);
      }
      return {
        status: result.status,
        message: result.message,
        data: result.data,
        errors: result.errors,
        ...(warnings.length > 0 && { warnings }),
      };
    }
    return { status: result.status, message: result.message, data: result.data, errors: result.errors };
  } catch (err) {
    Logger.log(`serverCreateUser error: ${String(err)}`);
    return { status: 'error', message: 'Internal error creating user' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverUpdateUser(payload: WithSession): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;

    const raw = sanitizePayload(payload as unknown as Record<string, unknown>);
    const validation = validateUpdateUserPayload(raw);
    if (validation.status !== ResultStatus.SUCCESS || !validation.data) {
      return { status: 'error', message: validation.message, errors: validation.errors };
    }
    const input = validation.data;

    const previous = findUserByEmail(input.email);
    const result = updateUser(input, auth.adminEmail);
    if (result.status === ResultStatus.SUCCESS && result.data) {
      appendAuditLog({
        actorEmail: auth.adminEmail, action: AuditAction.USER_UPDATED,
        resourceType: 'user', resourceId: input.email,
        details: input as unknown as Record<string, unknown>,
      });
      try {
        if (previous && previous.role !== result.data.role) {
          notifyUserRoleChanged(result.data, previous.role, auth.adminEmail);
        }
        if (previous && previous.status !== result.data.status) {
          notifyUserStatusChanged(result.data, auth.adminEmail);
        }
      } catch (emailErr) {
        Logger.log(`serverUpdateUser: notify* failed (non-fatal): ${String(emailErr)}`);
      }
    }
    return { status: result.status, message: result.message, data: result.data, errors: result.errors };
  } catch (err) {
    Logger.log(`serverUpdateUser error: ${String(err)}`);
    return { status: 'error', message: 'Internal error updating user' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverDeactivateUser(payload: WithSession<{ email: string }>): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;
    const emailResult = requireString(sanitizeEmail(payload?.email), 'email');
    if (emailResult.status !== ResultStatus.SUCCESS) {
      return { status: 'error', message: emailResult.message, errors: emailResult.errors };
    }
    const email = emailResult.data!;
    const result = deactivateUser(email);
    if (result.status === ResultStatus.SUCCESS && result.data) {
      appendAuditLog({
        actorEmail: auth.adminEmail, action: AuditAction.USER_DEACTIVATED,
        resourceType: 'user', resourceId: email, details: { email },
      });
      try {
        notifyUserStatusChanged(result.data, auth.adminEmail);
      } catch (emailErr) {
        Logger.log(`serverDeactivateUser: notifyUserStatusChanged failed (non-fatal): ${String(emailErr)}`);
      }
    }
    return { status: result.status, message: result.message, data: result.data };
  } catch (err) {
    Logger.log(`serverDeactivateUser error: ${String(err)}`);
    return { status: 'error', message: 'Internal error deactivating user' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function serverReactivateUser(payload: WithSession<{ email: string }>): ServerResponse {
  try {
    const auth = requireAdminOrFail(payload?.sessionToken);
    if (!auth.ok) return auth.response;
    const emailResult = requireString(sanitizeEmail(payload?.email), 'email');
    if (emailResult.status !== ResultStatus.SUCCESS) {
      return { status: 'error', message: emailResult.message, errors: emailResult.errors };
    }
    const email = emailResult.data!;
    const result = reactivateUser(email);
    if (result.status === ResultStatus.SUCCESS && result.data) {
      appendAuditLog({
        actorEmail: auth.adminEmail, action: AuditAction.USER_REACTIVATED,
        resourceType: 'user', resourceId: email, details: { email },
      });
      try {
        notifyUserStatusChanged(result.data, auth.adminEmail);
      } catch (emailErr) {
        Logger.log(`serverReactivateUser: notifyUserStatusChanged failed (non-fatal): ${String(emailErr)}`);
      }
    }
    return { status: result.status, message: result.message, data: result.data };
  } catch (err) {
    Logger.log(`serverReactivateUser error: ${String(err)}`);
    return { status: 'error', message: 'Internal error reactivating user' };
  }
}
