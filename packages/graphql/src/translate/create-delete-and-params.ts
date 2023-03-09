/*
 * Copyright (c) "Neo4j"
 * Neo4j Sweden AB [http://neo4j.com]
 *
 * This file is part of Neo4j.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { Node, Relationship } from "../classes";
import type { Context } from "../types";
import { createAuthAndParams } from "./create-auth-and-params";
import createConnectionWhereAndParams from "./where/create-connection-where-and-params";
import { AUTH_FORBIDDEN_ERROR, META_CYPHER_VARIABLE } from "../constants";
import { createEventMetaObject } from "./subscriptions/create-event-meta";
import { createConnectionEventMetaObject } from "./subscriptions/create-connection-event-meta";
import { filterMetaVariable } from "./subscriptions/filter-meta-variable";
import type { WithProjection } from "@neo4j/cypher-builder/src/clauses/With";
import Cypher from "@neo4j/cypher-builder";
import { caseWhere } from "../utils/case-where";

interface Res {
    strs: string[];
    params: any;
}

function createDeleteAndParams({
    deleteInput,
    varName,
    node,
    parentVar,
    chainStr,
    withVars,
    context,
    insideDoWhen,
    parameterPrefix,
    recursing,
}: {
    parentVar: string;
    deleteInput: any;
    varName: string;
    chainStr?: string;
    node: Node;
    withVars: string[];
    context: Context;
    insideDoWhen?: boolean;
    parameterPrefix: string;
    recursing?: boolean;
}): [string, any] {
    function reducer(res: Res, [key, value]: [string, any]) {
        const relationField = node.relationFields.find((x) => key === x.fieldName);

        if (relationField) {
            const refNodes: Node[] = [];

            const relationship = context.relationships.find(
                (x) => x.properties === relationField.properties
            ) as unknown as Relationship;

            if (relationField.union) {
                Object.keys(value).forEach((unionTypeName) => {
                    refNodes.push(context.nodes.find((x) => x.name === unionTypeName) as Node);
                });
            } else if (relationField.interface) {
                relationField.interface.implementations?.forEach((implementationName) => {
                    refNodes.push(context.nodes.find((x) => x.name === implementationName) as Node);
                });
            } else {
                refNodes.push(context.nodes.find((x) => x.name === relationField.typeMeta.name) as Node);
            }

            const inStr = relationField.direction === "IN" ? "<-" : "-";
            const outStr = relationField.direction === "OUT" ? "->" : "-";

            refNodes.forEach((refNode) => {
                const v = relationField.union ? value[refNode.name] : value;
                const deletes = relationField.typeMeta.array ? v : [v];

                deletes.forEach((d, index) => {
                    const innerStrs: string[] = [];
                    const variableName = chainStr
                        ? `${varName}${index}`
                        : `${varName}_${key}${
                              relationField.union || relationField.interface ? `_${refNode.name}` : ""
                          }${index}`;
                    const relationshipVariable = `${variableName}_relationship`;
                    const relTypeStr = `[${relationshipVariable}:${relationField.type}]`;
                    const withRelationshipStr = context.subscriptionsEnabled ? `, ${relationshipVariable}` : "";

                    // if (withVars) {
                    //     res.strs.push(`WITH ${withVars.join(", ")}`);
                    // }

                    const labels = refNode.getLabelString(context);
                    // res.strs.push(
                    //     `OPTIONAL MATCH (${parentVar})${inStr}${relTypeStr}${outStr}(${variableName}${labels})`
                    // );

                    const varsWithoutMeta = filterMetaVariable(withVars).join(", ");
                    innerStrs.push("WITH *");
                    innerStrs.push("CALL {");

                    if (withVars) {
                        //TODO
                        if (context.subscriptionsEnabled) {
                            innerStrs.push(`WITH ${varsWithoutMeta}`);
                            innerStrs.push(`WITH ${varsWithoutMeta}, []  AS meta`);
                        } else {
                            innerStrs.push(`WITH ${withVars.join(", ")}`);
                        }
                    }

                    innerStrs.push(
                        `OPTIONAL MATCH (${parentVar})${inStr}${relTypeStr}${outStr}(${variableName}${labels})`
                    );

                    const whereStrs: string[] = [];
                    let aggregationWhere = false;
                    if (d.where) {
                        try {
                            const {
                                cypher: whereCypher,
                                subquery: preComputedSubqueries,
                                params: whereParams,
                            } = createConnectionWhereAndParams({
                                nodeVariable: variableName,
                                whereInput: d.where,
                                node: refNode,
                                context,
                                relationshipVariable,
                                relationship,
                                parameterPrefix: `${parameterPrefix}${!recursing ? `.${key}` : ""}${
                                    relationField.union ? `.${refNode.name}` : ""
                                }${relationField.typeMeta.array ? `[${index}]` : ""}.where`,
                            });
                            if (whereCypher) {
                                console.log("where cypher", innerStrs);
                                whereStrs.push(whereCypher);
                                res.params = { ...res.params, ...whereParams };
                                if (preComputedSubqueries) {
                                    console.log("preComputedSubqueries", preComputedSubqueries);
                                    innerStrs.push(preComputedSubqueries);
                                    aggregationWhere = true;
                                }
                            }
                        } catch (err) {
                            console.error("errorrr!", err);
                            innerStrs.push(" \n}");
                            return;
                        }
                    }

                    const whereAuth = createAuthAndParams({
                        operations: "DELETE",
                        entity: refNode,
                        context,
                        where: { varName: variableName, node: refNode },
                    });
                    if (whereAuth[0]) {
                        whereStrs.push(whereAuth[0]);
                        res.params = { ...res.params, ...whereAuth[1] };
                    }
                    if (whereStrs.length) {
                        const predicate = `${whereStrs.join(" AND ")}`;
                        if (aggregationWhere) {
                            const columns = [
                                new Cypher.NamedVariable(relationshipVariable),
                                new Cypher.NamedVariable(variableName),
                            ];
                            const caseWhereClause = caseWhere(new Cypher.RawCypher(predicate), columns);
                            const { cypher } = caseWhereClause.build("aggregateWhereFilter");
                            innerStrs.push(cypher);
                        } else {
                            innerStrs.push(`WHERE ${predicate}`);
                        }
                    }

                    let whereStatements, authStatements;
                    if (whereStrs.length) {
                        whereStatements = new Cypher.RawCypher(() => {
                            return `WHERE ${whereStrs.join(" AND ")}`;
                        });
                    }

                    const allowAuth = createAuthAndParams({
                        entity: refNode,
                        operations: "DELETE",
                        context,
                        escapeQuotes: Boolean(insideDoWhen),
                        allow: { parentNode: refNode, varName: variableName },
                    });
                    if (allowAuth[0]) {
                        const quote = insideDoWhen ? `\\"` : `"`;
                        innerStrs.push(
                            // `WITH ${[...filterMetaVariable(withVars), variableName, relationshipVariable].join(", ")}${withRelationshipStr}`
                            `WITH ${varsWithoutMeta}${
                                context.subscriptionsEnabled ? ", meta" : ""
                            }, ${variableName}, ${relationshipVariable}`
                        );
                        innerStrs.push(
                            `CALL apoc.util.validate(NOT (${allowAuth[0]}), ${quote}${AUTH_FORBIDDEN_ERROR}${quote}, [0])`
                        );
                        res.params = { ...res.params, ...allowAuth[1] };

                        // authStatements = new Cypher.RawCypher(() => {
                        //     return [
                        //         `WITH ${[
                        //             ...filterMetaVariable(withVars),
                        //             "meta",
                        //             variableName,
                        //             relationshipVariable,
                        //         ].join(", ")}`,
                        //         `CALL apoc.util.validate(NOT (${allowAuth[0]}), ${quote}${AUTH_FORBIDDEN_ERROR}${quote}, [0])`,
                        //     ].join("/n");
                        // });
                    }

                    if (d.delete) {
                        const nestedDeleteInput = Object.entries(d.delete)
                            .filter(([k]) => {
                                if (k === "_on") {
                                    return false;
                                }

                                if (relationField.interface && d.delete?._on?.[refNode.name]) {
                                    const onArray = Array.isArray(d.delete._on[refNode.name])
                                        ? d.delete._on[refNode.name]
                                        : [d.delete._on[refNode.name]];
                                    if (onArray.some((onKey) => Object.prototype.hasOwnProperty.call(onKey, k))) {
                                        return false;
                                    }
                                }

                                return true;
                            })
                            .reduce((d1, [k1, v1]) => ({ ...d1, [k1]: v1 }), {});
                        const innerWithVars = context.subscriptionsEnabled
                            ? [...withVars, variableName, relationshipVariable]
                            : [...withVars, variableName];

                        const deleteAndParams = createDeleteAndParams({
                            context,
                            node: refNode,
                            deleteInput: nestedDeleteInput,
                            varName: variableName,
                            withVars: innerWithVars,
                            parentVar: variableName,
                            parameterPrefix: `${parameterPrefix}${!recursing ? `.${key}` : ""}${
                                relationField.union ? `.${refNode.name}` : ""
                            }${relationField.typeMeta.array ? `[${index}]` : ""}.delete`,
                            recursing: false,
                        });
                        innerStrs.push(deleteAndParams[0]);
                        res.params = { ...res.params, ...deleteAndParams[1] };

                        if (relationField.interface && d.delete?._on?.[refNode.name]) {
                            const onDeletes = Array.isArray(d.delete._on[refNode.name])
                                ? d.delete._on[refNode.name]
                                : [d.delete._on[refNode.name]];

                            onDeletes.forEach((onDelete, onDeleteIndex) => {
                                const onDeleteAndParams = createDeleteAndParams({
                                    context,
                                    node: refNode,
                                    deleteInput: onDelete,
                                    varName: variableName,
                                    withVars: innerWithVars,
                                    parentVar: variableName,
                                    parameterPrefix: `${parameterPrefix}${!recursing ? `.${key}` : ""}${
                                        relationField.union ? `.${refNode.name}` : ""
                                    }${relationField.typeMeta.array ? `[${index}]` : ""}.delete._on.${
                                        refNode.name
                                    }[${onDeleteIndex}]`,
                                    recursing: false,
                                });
                                innerStrs.push(onDeleteAndParams[0]);
                                res.params = { ...res.params, ...onDeleteAndParams[1] };
                            });
                        }
                    }

                    const nodeToDelete = `${variableName}_to_delete`;

                    // res.strs.push(
                    //     `WITH ${[...withVars, `collect(DISTINCT ${variableName}) AS ${nodeToDelete}`].join(
                    //         ", "
                    //     )}${withRelationshipStr}`
                    // );

                    /**
                     * This ORDER BY is required to prevent hitting the "Node with id 2 has been deleted in this transaction"
                     * bug. TODO - remove once the bug has bee fixed.
                     */
                    // if (aggregationWhere) res.strs.push(`ORDER BY ${nodeToDelete} DESC`);

                    if (context.subscriptionsEnabled) {
                        const metaObjectStr = createEventMetaObject({
                            event: "delete",
                            nodeVariable: "x",
                            typename: refNode.name,
                        });
                        const [fromVariable, toVariable] =
                            relationField.direction === "IN" ? ["x", parentVar] : [parentVar, "x"];
                        const [fromTypename, toTypename] =
                            relationField.direction === "IN" ? [refNode.name, node.name] : [node.name, refNode.name];
                        const eventWithMetaStr = createConnectionEventMetaObject({
                            event: "delete_relationship",
                            relVariable: relationshipVariable,
                            fromVariable,
                            toVariable,
                            typename: relationField.type,
                            fromTypename,
                            toTypename,
                        });
                        const reduceStr = `REDUCE(m=${META_CYPHER_VARIABLE}, n IN ${nodeToDelete} | m + ${metaObjectStr} + ${eventWithMetaStr}) AS ${META_CYPHER_VARIABLE}`;
                        const eventMetaWithClause = new Cypher.RawCypher((env: Cypher.Environment) => {
                            // return `${metaObjectStr} AS node_meta, x, ${relationshipVariable}, ${varsWithoutMeta}`;
                            return `${[...filterMetaVariable(withVars), nodeToDelete].join(", ")}, ${reduceStr}`;
                        });

                        // --------------------------------------
                        /*
                        const withVarsWithoutMetaStatement = filterMetaVariable(withVars).map(
                            (v) => new Cypher.NamedVariable(v)
                        );
                        
                        const metaVar = new Cypher.NamedVariable("meta");
                        const listAsMeta = [new Cypher.Literal([]), metaVar];

                        const relationshipVar = new Cypher.NamedVariable(relationshipVariable);
                        const nodeMetaVar = new Cypher.NamedVariable("node_meta");
                        const deleteMetaVar = new Cypher.NamedVariable("delete_meta");

                        const unwindVar = new Cypher.NamedVariable("x");
                        const nodeToDeleteVar = new Cypher.NamedNode(nodeToDelete);
                        const aliasedNodeToDelete = [nodeToDeleteVar, unwindVar] as WithProjection;

                        const unwindNode = new Cypher.NamedNode("x", {
                            labels: refNode.getLabels(context),
                        });
                        const node1 = new Cypher.NamedNode(variableName, {
                            labels: refNode.getLabels(context),
                        });
                        const node2 = new Cypher.NamedNode(parentVar);
                        const optionalMatchSt = new Cypher.OptionalMatch(
                            new Cypher.Pattern(node1)
                                .related(new Cypher.Relationship({ type: relationField.type }))
                                .to(node2)
                        );

                        const innerSubqueryEnabled = new Cypher.Call(
                            new Cypher.Unwind(aliasedNodeToDelete)
                                .with(eventMetaWithClause as unknown as WithProjection)
                                .detachDelete(unwindNode)
                                .return([Cypher.collect(nodeMetaVar), deleteMetaVar])
                        ).innerWith(...withVarsWithoutMetaStatement, relationshipVar, nodeToDeleteVar);

                        const outerSubqueryEnabled = Cypher.concat(
                            new Cypher.With(...withVarsWithoutMetaStatement).addColumns(listAsMeta as WithProjection),
                            optionalMatchSt,
                            whereStatements,
                            authStatements, //recursive call
                            new Cypher.With(...withVarsWithoutMetaStatement)
                                .addColumns(metaVar)
                                .addColumns(relationshipVar)
                                .addColumns([Cypher.collect(node1), nodeToDeleteVar]), //distinct!!
                            innerSubqueryEnabled,
                            new Cypher.With([Cypher.collect(deleteMetaVar), deleteMetaVar], metaVar), // `WITH collect(delete_meta) AS delete_meta, meta`,
                            new Cypher.Return(deleteMetaVar) // `RETURN REDUCE(m=meta, n IN delete_meta | m + n) AS delete_meta`,
                        );
                        const startStatements = Cypher.concat(
                            new Cypher.With("*"),
                            new Cypher.Call(outerSubqueryEnabled).innerWith(...withVarsWithoutMetaStatement),
                            new Cypher.With(), //   `WITH ${varsWithoutMeta}, meta, collect(delete_meta) AS delete_meta`,
                            new Cypher.With() //    `WITH ${varsWithoutMeta}, REDUCE(m=meta, n IN delete_meta | m + n) AS meta`,
                        );
                        // console.log("start", startStatements);
                        */
                        // --------------------------------------

                        //  need relationshipVariable for disconnect meta
                        const statements = [
                            `WITH ${varsWithoutMeta}, meta, ${relationshipVariable}, collect(DISTINCT ${variableName}) AS ${nodeToDelete}`,
                            // `${aggregationWhere ? `ORDER BY ${nodeToDelete} DESC` : ""}`,
                            "CALL {",
                            `\tWITH ${relationshipVariable}, ${nodeToDelete}, ${varsWithoutMeta}`,
                            `\tUNWIND ${nodeToDelete} AS x`,
                            `\tWITH [] + ${metaObjectStr} + ${eventWithMetaStr} AS meta, x, ${relationshipVariable}, ${varsWithoutMeta}`,
                            `\tDETACH DELETE x`,
                            `\tRETURN collect(meta) AS delete_meta`,
                            `}`,
                            `WITH delete_meta, meta`,
                            `RETURN REDUCE(m=meta, n IN delete_meta | m + n) AS delete_meta`,
                            `}`,
                            `WITH ${varsWithoutMeta}, meta, collect(delete_meta) as delete_meta`,
                            `WITH ${varsWithoutMeta}, REDUCE(m=meta, n IN delete_meta | m + n) AS meta`,
                        ];

                        innerStrs.push(...statements);
                    } else {
                        const statements = [
                            `WITH ${relationshipVariable}, collect(DISTINCT ${variableName}) AS ${nodeToDelete}`,
                            // `ORDER BY ${nodeToDelete} DESC`,
                            "CALL {",
                            `\tWITH ${nodeToDelete}`,
                            `\tUNWIND ${nodeToDelete} AS x`,
                            `\tDETACH DELETE x`,
                            // `\tRETURN count(*) AS _`,
                            `}`,
                            // `RETURN count(*) AS _${relationshipVariable}`,
                            `}`,
                        ];
                        innerStrs.push(...statements);
                    }
                    res.strs.push(...innerStrs);
                });
            });

            return res;
        }

        return res;
    }

    const { strs, params } = Object.entries(deleteInput).reduce(reducer, { strs: [], params: {} });

    return [strs.join("\n"), params];
}

export default createDeleteAndParams;
