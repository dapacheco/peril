import {
  connectionArgs,
  connectionDefinitions,
  connectionFromArray,
  fromGlobalId,
  globalIdResolver,
  nodeDefinitions,
  nodeField,
  nodeInterface,
  pageInfoType,
} from "graphql-relay-tools"

import { makeExecutableSchema } from "graphql-tools"
import { Date, JSON } from "graphql-tools-types"

import { GitHubInstallation } from "../../db"
import { getDB } from "../../db/getDB"
import { MongoDB } from "../../db/mongo"
import { getRecordedWebhooksForInstallation } from "../../plugins/utils/recordWebhookWithRequest"

import { GraphQLContext } from "../api"
import { getDetailsFromPerilJWT } from "../auth/generate"
import { gql } from "./gql"
import { mutations } from "./mutations"
import { authD } from "./utils/auth"
import { getUserInstallations } from "./utils/installations"

const { connectionType: partialConnection } = connectionDefinitions({ name: "PartialInstallation" })
const { connectionType: installationConnection } = connectionDefinitions({ name: "Installation" })
const { connectionType: recordedWebhookConnection } = connectionDefinitions({ name: "RecordedWebhook" })

const { nodeResolver } = nodeDefinitions(async globalId => {
  const { type, id } = fromGlobalId(globalId)
  const db = getDB() as MongoDB

  if (type === "Installation") {
    return await db.getInstallationByDBID(id)
  }

  throw new Error("Unknown type passed to nodeID")
})

const schemaSDL = gql`
  # Basically a way to say this is going to be untyped data (it's normally user input)
  scalar JSON
  scalar Date

  # An installation of Peril which isn't set up yet
  type PartialInstallation implements Node {
    # The MongoDB ID
    id: ID!
    # The installation ID, in the real sense
    iID: Int!
    # The name of the installation owner
    login: String!
    # The URL for an image representing the installation owner
    avatarURL: String!
  }

  # An installation of Peril, ideally not too tightly tied to GH
  type Installation implements Node {
    # The MongoDB ID
    id: ID!
    # The installation ID, in the real sense
    iID: Int!
    # The path to the Dangerfile
    perilSettingsJSONURL: String!
    # The name of a user/org which the installation is attached to
    login: String!
    # The URL for an image representing the installation owner
    avatarURL: String!
    # A set of per repo rules
    repos: JSON!
    # Rules that are for all repos
    rules: JSON!
    # Scheduled tasks to run repeatedly
    scheduler: JSON!
    # Installation settings, for example ignored repos
    settings: JSON!
    # Tasks which you can schedule to run in the future
    tasks: JSON!
    # Saved webhooks which can be re-sent
    webhooks${connectionArgs()}: RecordedWebhookConnection
    # User-environment variables
    envVars: JSON
  }

  # Someone logged in to the API, all user data is stored inside the JWT
  type User {
    # Display name
    name: String!
    # Use this to show an avatar
    avatarURL: String!
    # The installations that a user has access to
    installations${connectionArgs()}: InstallationConnection
    # The installations that a user has access to, but hasn't been set up yet
    installationsToSetUp${connectionArgs()}: PartialInstallationConnection
  }

  # A stored webhook from GitHub so we can re-send it in the future
  type RecordedWebhook {
    # Installation ID
    iID: Int!
    # A string like 'pull_request.closed' to show the preview
    event: String!
    # The webhook JSON, it will not be included in collections of webhooks
    json: JSON
    # The UUID from GitHub for the webhook
    eventID: String!
    # The time when the recording was made
    createdAt: Date!
  }

  # Root
  type Query {
    # The logged in user
    me: User
    # Get information about an installation
    installation(iID: Int!): Installation
    ${nodeField}
  }

  type MutationWithSuccess {
    success: Boolean
  }

  type Mutation {
    # Building this out incrementally, but basically this provides
    # the ability to set the URL that Peril should grab data from
    editInstallation(iID: Int!, perilSettingsJSONURL: String!): Installation
    # Sets the installation to record webhooks for the next 5m
    makeInstallationRecord(iID: Int!): Installation
    # Send webhook
    sendWebhookForInstallation(iID: Int!, eventID: String!): RecordedWebhook
    # Adds/edits/removes a new ENV var to an installation.
    # Returns the whole env for the installation.
    changeEnvVarForInstallation(iID: Int!, key: String!, value: String): JSON
    # Trigger a named task from the installation's settings 
    runTask(iID: Int!, task: String!, data: JSON): MutationWithSuccess
    # Schedule a named task, with a JWT passed by Peril to a unique sandbox run
    scheduleTask(jwt: String!, task: String!, time: String!, data: JSON): MutationWithSuccess
    # Triggers a message to admins in the dashboard, and prepares to grab the logs
    dangerfileFinished(jwt: String!, dangerfiles: [String!]!, time: Int!, dangerRunID: String!): MutationWithSuccess
  }
`

const resolvers = {
  // Let's graphql-tools-types handle the user-data and just puts the whole obj in response
  JSON: JSON({ name: "Any" }),
  Date: Date({ name: "JSDate" }),

  User: {
    // Installations with useful data
    installations: authD(async (_: any, args: any, context: GraphQLContext) => {
      const installations = await getUserInstallations(context.jwt)
      return connectionFromArray(installations.filter(i => i.perilSettingsJSONURL), args)
    }),
    // Ready to set up installations with a subset of the data
    installationsToSetUp: authD(async (_: any, args: any, context: GraphQLContext) => {
      const installations = await getUserInstallations(context.jwt)
      return connectionFromArray(installations.filter(i => !i.perilSettingsJSONURL), args)
    }),
  },

  Installation: {
    webhooks: authD(async (parent: Partial<GitHubInstallation>, args: any, _: GraphQLContext) => {
      const installationID = parent.iID!
      const webhooks = await getRecordedWebhooksForInstallation(installationID)
      return connectionFromArray(webhooks, args)
    }),
    id: globalIdResolver(),
  },
  PartialInstallation: {
    id: globalIdResolver(),
  },

  Query: {
    // Extract metadata from the JWT
    me: authD(async (_: any, __: any, context: GraphQLContext) => {
      const decodedJWT = await getDetailsFromPerilJWT(context.jwt)
      return decodedJWT.data.user
    }),

    installation: authD(async (_: any, params: { iID: number }, context: GraphQLContext) => {
      const installations = await getUserInstallations(context.jwt)
      return installations.find(i => i.iID === params.iID)
    }),

    node: nodeResolver,
  },

  Mutation: {
    ...mutations,
  },
  Node: {
    __resolveType: (obj: any) => {
      return obj.perilSettingsJSONURL ? "Installation" : "PartialInstallation"
    },
  },
}

const connections = [installationConnection, partialConnection, recordedWebhookConnection]

export const schema = makeExecutableSchema<GraphQLContext>({
  typeDefs: [schemaSDL, pageInfoType, ...connections, nodeInterface],
  resolvers,
})
