import { ForbiddenError } from './errors';

export function validateOwnership(
  resource: { userId: string } | null | undefined,
  currentUserId: string,
  resourceName: string = 'Resource'
): asserts resource is { userId: string } {
  if (!resource) {
    throw new ForbiddenError(`${resourceName} not found`);
  }

  if (resource.userId !== currentUserId) {
    const lower = resourceName.toLowerCase();
    throw new ForbiddenError(`You do not have permission to access this ${lower}`);
  }
}
