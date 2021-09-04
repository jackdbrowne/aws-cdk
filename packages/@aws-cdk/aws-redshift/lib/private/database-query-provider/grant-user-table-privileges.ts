/* eslint-disable-next-line import/no-unresolved */
import * as AWSLambda from 'aws-lambda';
import { TablePrivilege, UserTablePrivilegesHandlerProps } from '../handler-props';
import { ClusterProps, executeStatement } from './util';

export async function handler(props: UserTablePrivilegesHandlerProps & ClusterProps, event: AWSLambda.CloudFormationCustomResourceEvent) {
  const username = props.username;
  const tablePrivileges = props.tablePrivileges;
  const clusterProps = props;

  if (event.RequestType === 'Create') {
    await grantPrivileges(username, tablePrivileges, clusterProps);
    return { PhysicalResourceId: username };
  } else if (event.RequestType === 'Delete') {
    await revokePrivileges(username, tablePrivileges, clusterProps);
    return;
  } else if (event.RequestType === 'Update') {
    await updatePrivileges(username, tablePrivileges, clusterProps, event.OldResourceProperties as UserTablePrivilegesHandlerProps & ClusterProps);
    return { PhysicalResourceId: username };
  } else {
    /* eslint-disable-next-line dot-notation */
    throw new Error(`Unrecognized event type: ${event['RequestType']}`);
  }
}

async function revokePrivileges(username: string, tablePrivileges: TablePrivilege[], clusterProps: ClusterProps) {
  await Promise.all(tablePrivileges.map(({ tableName, actions }) => {
    return executeStatement(`REVOKE ${actions.join(', ')} ON ${tableName} FROM ${username}`, clusterProps);
  }));
}

async function grantPrivileges(username: string, tablePrivileges: TablePrivilege[], clusterProps: ClusterProps) {
  await Promise.all(tablePrivileges.map(({ tableName, actions }) => {
    return executeStatement(`GRANT ${actions.join(', ')} ON ${tableName} TO ${username}`, clusterProps);
  }));
}

async function updatePrivileges(
  username: string,
  tablePrivileges: TablePrivilege[],
  clusterProps: ClusterProps,
  oldResourceProperties: UserTablePrivilegesHandlerProps & ClusterProps,
) {
  const oldUsername = oldResourceProperties.username;
  const oldTablePrivileges = oldResourceProperties.tablePrivileges;
  if (oldUsername === username) {
    await revokePrivileges(username, oldTablePrivileges, clusterProps);
  }
  await grantPrivileges(username, tablePrivileges, clusterProps);
}