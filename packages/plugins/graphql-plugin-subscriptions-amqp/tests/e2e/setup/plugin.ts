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

import amqp from "amqplib";
import { Neo4jGraphQLSubscriptionsAMQP } from "../../../src";

export default async function createPlugin(connection: amqp.Connection): Promise<Neo4jGraphQLSubscriptionsAMQP> {
    const plugin = new Neo4jGraphQLSubscriptionsAMQP({
        exchange: "neo4j-graphql",
    });

    await plugin.connect(connection);

    return plugin;
}