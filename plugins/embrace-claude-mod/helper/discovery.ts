// Map discovery requests to the authenticated query transport.
// Usage: cli.ts discover/describe subcommands; no persistent metadata cache.

export const LIST_QUERIES = 'v3.discovery.listQueries';
export const DESCRIBE_QUERY = 'v3.discovery.describeQuery';
export const LIST_MUTATIONS = 'v3.discovery.listMutations';
export const DESCRIBE_MUTATION = 'v3.discovery.describeMutation';
export const EXECUTE_MUTATION = 'v3.discovery.executeMutation';
export type OperationType = 'query' | 'mutation';

export function discoveryRequest(args: {
  command: 'discover' | 'describe';
  type?: OperationType;
  name?: string;
  search?: string;
  limit?: number;
  after?: string;
}): { procedure: string; inputJson: string } {
  const type = args.type ?? 'query';
  if (type !== 'query' && type !== 'mutation') throw new Error('type must be query or mutation');
  if (args.command === 'describe') {
    if (!args.name || !/^v3\.[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)+$/.test(args.name) || args.name.length > 200) {
      throw new Error('describe requires a valid v3 query name (at most 200 characters)');
    }
    return { procedure: type === 'mutation' ? DESCRIBE_MUTATION : DESCRIBE_QUERY, inputJson: JSON.stringify({ name: args.name }) };
  }
  if ((args.search?.length ?? 0) > 200 || (args.after?.length ?? 0) > 200) {
    throw new Error('discovery search and cursor must be at most 200 characters');
  }
  const limit = args.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('discovery limit must be an integer between 1 and 100');
  }
  return {
    procedure: type === 'mutation' ? LIST_MUTATIONS : LIST_QUERIES,
    inputJson: JSON.stringify({ search: args.search ?? '', limit, after: args.after ?? null }),
  };
}
