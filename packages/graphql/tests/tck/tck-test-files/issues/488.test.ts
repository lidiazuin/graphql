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

import { gql } from "apollo-server";
import type { DocumentNode } from "graphql";
import { Neo4jGraphQL } from "../../../../src";
import { createJwtRequest } from "../../../utils/create-jwt-request";
import { formatCypher, translateQuery, formatParams } from "../../utils/tck-test-utils";

describe("#488", () => {
    let typeDefs: DocumentNode;
    let neoSchema: Neo4jGraphQL;

    beforeAll(() => {
        typeDefs = gql`
            type Journalist {
                name: String!
                keywords: [Keyword!]! @relationship(type: "HAS_KEYWORD", direction: OUT)
            }

            union Keyword = Emoji | Hashtag | Text

            type Emoji {
                id: ID! @id
                type: String!
            }

            type Hashtag {
                id: ID! @id
                type: String!
            }

            type Text {
                id: ID! @id
                type: String!
            }
        `;

        neoSchema = new Neo4jGraphQL({
            typeDefs,
            config: { enableRegex: true },
        });
    });

    test("Should replicate issue and return correct cypher", async () => {
        const query = gql`
            query {
                journalists(where: { keywordsConnection: { Emoji: { node: { type: "Smile" } } } }) {
                    name
                    keywords {
                        ... on Emoji {
                            id
                            type
                        }
                    }
                }
            }
        `;

        const req = createJwtRequest("secret", {});
        const result = await translateQuery(neoSchema, query, {
            req,
        });

        expect(formatCypher(result.cypher)).toMatchInlineSnapshot(`
            "MATCH (this:\`Journalist\`)
            WHERE size([(this)-[this0:HAS_KEYWORD]->(this1:\`Emoji\`) WHERE this1.type = $param0 | 1]) > 0
            CALL {
                WITH this
                CALL {
                    WITH this
                    MATCH (this)-[thisthis0:HAS_KEYWORD]->(this_keywords_0:\`Emoji\`)
                    WITH this_keywords_0  { __resolveType: \\"Emoji\\",  .id, .type } AS this_keywords_0
                    RETURN collect(this_keywords_0) AS this_keywords_0
                }
                CALL {
                    WITH this
                    MATCH (this)-[thisthis1:HAS_KEYWORD]->(this_keywords_1:\`Hashtag\`)
                    WITH this_keywords_1 { __resolveType: \\"Hashtag\\" } AS this_keywords_1
                    RETURN collect(this_keywords_1) AS this_keywords_1
                }
                CALL {
                    WITH this
                    MATCH (this)-[thisthis2:HAS_KEYWORD]->(this_keywords_2:\`Text\`)
                    WITH this_keywords_2 { __resolveType: \\"Text\\" } AS this_keywords_2
                    RETURN collect(this_keywords_2) AS this_keywords_2
                }
                WITH this_keywords_0 + this_keywords_1 + this_keywords_2 AS thisvar3
                UNWIND thisvar3 AS thisvar4
                WITH thisvar4
                RETURN collect(thisvar4) AS this_keywords
            }
            RETURN this { .name, keywords: this_keywords } as this"
        `);

        expect(formatParams(result.params)).toMatchInlineSnapshot(`
            "{
                \\"param0\\": \\"Smile\\"
            }"
        `);
    });

    test("Should replicate issue and return correct cypher (using not)", async () => {
        const query = gql`
            query {
                journalists(where: { keywordsConnection_NOT: { Emoji: { node: { type: "Smile" } } } }) {
                    name
                    keywords {
                        ... on Emoji {
                            id
                            type
                        }
                    }
                }
            }
        `;

        const req = createJwtRequest("secret", {});
        const result = await translateQuery(neoSchema, query, {
            req,
        });

        expect(formatCypher(result.cypher)).toMatchInlineSnapshot(`
            "MATCH (this:\`Journalist\`)
            WHERE size([(this)-[this0:HAS_KEYWORD]->(this1:\`Emoji\`) WHERE this1.type = $param0 | 1]) = 0
            CALL {
                WITH this
                CALL {
                    WITH this
                    MATCH (this)-[thisthis0:HAS_KEYWORD]->(this_keywords_0:\`Emoji\`)
                    WITH this_keywords_0  { __resolveType: \\"Emoji\\",  .id, .type } AS this_keywords_0
                    RETURN collect(this_keywords_0) AS this_keywords_0
                }
                CALL {
                    WITH this
                    MATCH (this)-[thisthis1:HAS_KEYWORD]->(this_keywords_1:\`Hashtag\`)
                    WITH this_keywords_1 { __resolveType: \\"Hashtag\\" } AS this_keywords_1
                    RETURN collect(this_keywords_1) AS this_keywords_1
                }
                CALL {
                    WITH this
                    MATCH (this)-[thisthis2:HAS_KEYWORD]->(this_keywords_2:\`Text\`)
                    WITH this_keywords_2 { __resolveType: \\"Text\\" } AS this_keywords_2
                    RETURN collect(this_keywords_2) AS this_keywords_2
                }
                WITH this_keywords_0 + this_keywords_1 + this_keywords_2 AS thisvar3
                UNWIND thisvar3 AS thisvar4
                WITH thisvar4
                RETURN collect(thisvar4) AS this_keywords
            }
            RETURN this { .name, keywords: this_keywords } as this"
        `);

        expect(formatParams(result.params)).toMatchInlineSnapshot(`
            "{
                \\"param0\\": \\"Smile\\"
            }"
        `);
    });
});
