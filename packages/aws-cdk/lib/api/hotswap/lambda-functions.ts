import { ISDK } from '../aws-auth';
import { ChangeHotswapImpact, ChangeHotswapResult, HotswapOperation, HotswappableChangeCandidate, establishResourcePhysicalName } from './common';
import { EvaluateCloudFormationTemplate } from './evaluate-cloudformation-template';

/**
 * Returns `ChangeHotswapImpact.REQUIRES_FULL_DEPLOYMENT` if the change cannot be short-circuited,
 * `ChangeHotswapImpact.IRRELEVANT` if the change is irrelevant from a short-circuit perspective
 * (like a change to CDKMetadata),
 * or a LambdaFunctionResource if the change can be short-circuited.
 */
export async function isHotswappableLambdaFunctionChange(
  logicalId: string, change: HotswappableChangeCandidate, evaluateCfnTemplate: EvaluateCloudFormationTemplate,
): Promise<ChangeHotswapResult> {
  const lambdaCodeChange = await isLambdaFunctionCodeOnlyChange(change, evaluateCfnTemplate);
  if (typeof lambdaCodeChange === 'string') {
    return lambdaCodeChange;
  } else {
    const functionName = await establishResourcePhysicalName(logicalId, change.newValue.Properties?.FunctionName, evaluateCfnTemplate);
    if (!functionName) {
      return ChangeHotswapImpact.REQUIRES_FULL_DEPLOYMENT;
    }

    const functionArn = await evaluateCfnTemplate.evaluateCfnExpression({
      'Fn::Sub': 'arn:${AWS::Partition}:lambda:${AWS::Region}:${AWS::AccountId}:function:' + functionName,
    });

    return new LambdaFunctionHotswapOperation({
      physicalName: functionName,
      functionArn: functionArn,
      resource: lambdaCodeChange,
    });
  }
}

/**
 * Returns `ChangeHotswapImpact.IRRELEVANT` if the change is not for a AWS::Lambda::Function,
 * but doesn't prevent short-circuiting
 * (like a change to CDKMetadata resource),
 * `ChangeHotswapImpact.REQUIRES_FULL_DEPLOYMENT` if the change is to a AWS::Lambda::Function,
 * but not only to its Code property,
 * or a LambdaFunctionCode if the change is to a AWS::Lambda::Function,
 * and only affects its Code property.
 */
async function isLambdaFunctionCodeOnlyChange(
  change: HotswappableChangeCandidate, evaluateCfnTemplate: EvaluateCloudFormationTemplate,
): Promise<LambdaFunctionChange | ChangeHotswapImpact> {
  const newResourceType = change.newValue.Type;
  if (newResourceType !== 'AWS::Lambda::Function') {
    return ChangeHotswapImpact.REQUIRES_FULL_DEPLOYMENT;
  }

  /*
   * On first glance, we would want to initialize these using the "previous" values (change.oldValue),
   * in case only one of them changed, like the key, and the Bucket stayed the same.
   * However, that actually fails for old-style synthesis, which uses CFN Parameters!
   * Because the names of the Parameters depend on the hash of the Asset,
   * the Parameters used for the "old" values no longer exist in `assetParams` at this point,
   * which means we don't have the correct values available to evaluate the CFN expression with.
   * Fortunately, the diff will always include both the s3Bucket and s3Key parts of the Lambda's Code property,
   * even if only one of them was actually changed,
   * which means we don't need the "old" values at all, and we can safely initialize these with just `''`.
   */
  // Make sure only the code in the Lambda function changed
  const propertyUpdates = change.propertyUpdates;
  let code: LambdaFunctionCode | undefined = undefined;
  let tags: LambdaFunctionTags | undefined = undefined;

  for (const updatedPropName in propertyUpdates) {
    const updatedProp = propertyUpdates[updatedPropName];

    switch (updatedPropName) {
      case 'Code':
        let foundCodeDifference = false;
        let s3Bucket = '', s3Key = '';

        for (const newPropName in updatedProp.newValue) {
          switch (newPropName) {
            case 'S3Bucket':
              foundCodeDifference = true;
              s3Bucket = await evaluateCfnTemplate.evaluateCfnExpression(updatedProp.newValue[newPropName]);
              break;
            case 'S3Key':
              foundCodeDifference = true;
              s3Key = await evaluateCfnTemplate.evaluateCfnExpression(updatedProp.newValue[newPropName]);
              break;
            default:
              return ChangeHotswapImpact.REQUIRES_FULL_DEPLOYMENT;
          }
        }
        if (foundCodeDifference) {
          code = {
            s3Bucket,
            s3Key,
          };
        }
        break;
      case 'Tags':
        /*
         * Tag updates are a bit odd; they manifest as two lists, are flagged only as
         * `isDifferent`, and we have to reconcile them.
         */
        const tagUpdates: { [tag: string]: string | TagDeletion } = {};
        if (updatedProp?.isDifferent) {
          updatedProp.newValue.forEach((tag: CfnDiffTagValue) => {
            tagUpdates[tag.Key] = tag.Value;
          });

          updatedProp.oldValue.forEach((tag: CfnDiffTagValue) => {
            if (tagUpdates[tag.Key] === undefined) {
              tagUpdates[tag.Key] = TagDeletion.DELETE;
            }
          });

          tags = { tagUpdates };
        }
        break;
      default:
        return ChangeHotswapImpact.REQUIRES_FULL_DEPLOYMENT;
    }
  }

  return code || tags ? { code, tags } : ChangeHotswapImpact.IRRELEVANT;
}

interface CfnDiffTagValue {
  readonly Key: string;
  readonly Value: string;
}

interface LambdaFunctionCode {
  readonly s3Bucket: string;
  readonly s3Key: string;
}

enum TagDeletion {
  DELETE = -1,
}

interface LambdaFunctionTags {
  readonly tagUpdates: { [tag : string] : string | TagDeletion };
}

interface LambdaFunctionChange {
  readonly code?: LambdaFunctionCode;
  readonly tags?: LambdaFunctionTags;
}

interface LambdaFunctionResource {
  readonly physicalName: string;
  readonly functionArn: string;
  readonly resource: LambdaFunctionChange;
}

class LambdaFunctionHotswapOperation implements HotswapOperation {
  public readonly service = 'lambda-function';
  public readonly resourceNames: string[];

  constructor(private readonly lambdaFunctionResource: LambdaFunctionResource) {
    this.resourceNames = [lambdaFunctionResource.physicalName];
  }

  public async apply(sdk: ISDK): Promise<any> {
    const lambda = sdk.lambda();
    const resource = this.lambdaFunctionResource.resource;
    const operations: Promise<any>[] = [];

    if (resource.code !== undefined) {
      operations.push(lambda.updateFunctionCode({
        FunctionName: this.lambdaFunctionResource.physicalName,
        S3Bucket: resource.code.s3Bucket,
        S3Key: resource.code.s3Key,
      }).promise());
    }

    if (resource.tags !== undefined) {
      const tagsToDelete: string[] = Object.entries(resource.tags.tagUpdates)
        .filter(([_key, val]) => val === TagDeletion.DELETE)
        .map(([key, _val]) => key);

      const tagsToSet: { [tag: string]: string } = {};
      Object.entries(resource.tags!.tagUpdates)
        .filter(([_key, val]) => val !== TagDeletion.DELETE)
        .forEach(([tagName, tagValue]) => {
          tagsToSet[tagName] = tagValue as string;
        });


      if (tagsToDelete.length > 0) {
        operations.push(lambda.untagResource({
          Resource: this.lambdaFunctionResource.functionArn,
          TagKeys: tagsToDelete,
        }).promise());
      }

      if (Object.keys(tagsToSet).length > 0) {
        operations.push(lambda.tagResource({
          Resource: this.lambdaFunctionResource.functionArn,
          Tags: tagsToSet,
        }).promise());
      }
    }

    // run all of our updates in parallel
    return Promise.all(operations);
  }
}
