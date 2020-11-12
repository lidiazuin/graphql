import { GraphQLResolveInfo } from "graphql";
import { parseResolveInfo, ResolveTree } from "graphql-parse-resolve-info";
import pluralize from "pluralize";
import { NeoSchema, Node } from "../classes";
import createWhereAndParams from "./create-where-and-params";
import createProjectionAndParams from "./create-projection-and-params";
import createCreateAndParams from "./create-create-and-params";
import { GraphQLWhereArg, GraphQLOptionsArg } from "../types";

function translateRead({ neoSchema, resolveTree }: { neoSchema: NeoSchema; resolveTree: ResolveTree }): [string, any] {
    const whereInput = resolveTree.args.where as GraphQLWhereArg;
    const optionsInput = resolveTree.args.options as GraphQLOptionsArg;
    const fieldsByTypeName = resolveTree.fieldsByTypeName;
    const node = neoSchema.nodes.find((x) => x.name === pluralize.singular(resolveTree.name)) as Node;
    const varName = "this";

    const matchStr = `MATCH (${varName}:${node.name})`;
    let whereStr = "";
    let skipStr = "";
    let limitStr = "";
    let sortStr = "";
    let projStr = "";
    let cypherParams: { [k: string]: any } = {};

    const projection = createProjectionAndParams({
        node,
        neoSchema,
        fieldsByTypeName,
        varName,
    });
    projStr = projection[0];
    cypherParams = { ...cypherParams, ...projection[1] };

    if (whereInput) {
        const where = createWhereAndParams({
            whereInput,
            varName,
        });
        whereStr = where[0];
        cypherParams = { ...cypherParams, ...where[1] };
    }

    if (optionsInput) {
        if (optionsInput.skip) {
            skipStr = `SKIP $${varName}_skip`;
            cypherParams[`${varName}_skip`] = optionsInput.skip;
        }

        if (optionsInput.limit) {
            limitStr = `LIMIT $${varName}_limit`;
            cypherParams[`${varName}_limit`] = optionsInput.limit;
        }

        if (optionsInput.sort && optionsInput.sort.length) {
            const sortArr = optionsInput.sort.map((s) => {
                let key;
                let direc;

                if (s.includes("_DESC")) {
                    direc = "DESC";
                    [key] = s.split("_DESC");
                } else {
                    direc = "ASC";
                    [key] = s.split("_ASC");
                }

                return `${varName}.${key} ${direc}`;
            });

            sortStr = `ORDER BY ${sortArr.join(", ")}`;
        }
    }

    const cypher = [
        matchStr,
        whereStr,
        `RETURN ${varName} ${projStr} as ${varName}`,
        `${sortStr || ""}`,
        `${skipStr || ""}`,
        `${limitStr || ""}`,
    ];

    return [cypher.filter(Boolean).join("\n"), cypherParams];
}

function translateCreate({
    neoSchema,
    resolveTree,
}: {
    neoSchema: NeoSchema;
    resolveTree: ResolveTree;
}): [string, any] {
    const fieldsByTypeName = resolveTree.fieldsByTypeName;
    const node = neoSchema.nodes.find(
        (x) => x.name === pluralize.singular(resolveTree.name.split("create")[1])
    ) as Node;

    const { createStrs, params } = (resolveTree.args.input as any[]).reduce(
        (res, input, index) => {
            const varName = `this${index}`;
            res.withVars.push(varName);

            const createAndParams = createCreateAndParams({ input, node, neoSchema, varName, withVars: res.withVars });
            const withStr =
                res.withVars.length > 1
                    ? `\nWITH ${[...res.withVars].slice(0, res.withVars.length - 1).join(", ")}`
                    : "";

            res.createStrs.push(`${withStr}\n${createAndParams[0]}`);
            res.params = { ...res.params, ...createAndParams[1] };

            return res;
        },
        { createStrs: [], params: {}, withVars: [] }
    ) as {
        createStrs: string[];
        params: any;
        withVars: string[];
    };

    /* so projection params don't conflict with create params. We only need to call createProjectionAndParams once. */
    const projection = createProjectionAndParams({
        node,
        neoSchema,
        fieldsByTypeName,
        varName: "REPLACE_ME",
    });
    const replacedProjectionParams = Object.entries(projection[1]).reduce((res, [key, value]) => {
        return { ...res, [key.replace("REPLACE_ME", "projection")]: value };
    }, {});
    const projectionStr = createStrs
        .map(
            (_, i) =>
                `\nthis${i} ${projection[0]
                    .replace(/\$REPLACE_ME/g, "$projection")
                    .replace(/REPLACE_ME/g, `this${i}`)} AS this${i}`
        )
        .join(", ");

    const cypher = `${createStrs.join("\n")}\n\nRETURN ${projectionStr}`;

    return [cypher, { ...params, ...replacedProjectionParams }];
}

function translate({ context, resolveInfo }: { context: any; resolveInfo: GraphQLResolveInfo }): [string, any] {
    const neoSchema: NeoSchema = context.neoSchema;
    if (!neoSchema || !(neoSchema instanceof NeoSchema)) {
        throw new Error("invalid schema");
    }

    const resolveTree = parseResolveInfo(resolveInfo) as ResolveTree;
    const operationType = resolveInfo.operation.operation;
    const operationName = resolveInfo.fieldName;

    if (operationType === "mutation") {
        if (operationName.includes("create")) {
            return translateCreate({ resolveTree, neoSchema });
        }
    }

    return translateRead({ resolveTree, neoSchema });
}

export default translate;
