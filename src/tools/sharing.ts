import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GraphQLClient } from "../graphqlClient.js";
import { receipt, text } from "../util/mcp.js";

const DOC_ROLES = ["Reader", "Commenter", "Editor", "Manager"] as const;
type DocRole = typeof DOC_ROLES[number];

// Per-person access on docs and workspace invitations (Miro's board_share / role_update equivalents).
export function registerSharingTools(server: McpServer, gql: GraphQLClient, defaults: { workspaceId?: string }) {
  const ws = (workspaceId?: string) => {
    const id = workspaceId || defaults.workspaceId;
    if (!id) throw new Error("workspaceId required (or set AFFINE_WORKSPACE_ID)");
    return id;
  };

  async function listMembers(workspaceId: string, query?: string, take = 100) {
    const data = await gql.request<{ workspace: { members: any[]; memberCount: number } }>(
      `query Members($id:String!,$query:String,$take:Int){ workspace(id:$id){ memberCount members(query:$query, take:$take){ id name email role status } } }`,
      { id: workspaceId, query, take },
    );
    return data.workspace;
  }

  // Accept user ids or emails; emails resolve against current workspace members.
  async function resolveUserIds(workspaceId: string, users: string[]): Promise<string[]> {
    const emails = users.filter(u => u.includes("@"));
    if (emails.length === 0) return users;
    const { members } = await listMembers(workspaceId, undefined, 1000);
    return users.map(u => {
      if (!u.includes("@")) return u;
      const hit = members.find(m => m.email?.toLowerCase() === u.toLowerCase());
      if (!hit) throw new Error(`${u} is not a member of this workspace. Invite them first with invite_members.`);
      return hit.id;
    });
  }

  server.registerTool(
    "list_workspace_members",
    {
      title: "List Workspace Members",
      description: "List workspace members with their id, name, email, workspace role and status (Accepted, Pending...). Use it to find user ids before sharing a doc.",
      inputSchema: {
        workspaceId: z.string().optional(),
        query: z.string().optional().describe("Optional name/email filter."),
        take: z.number().int().min(1).max(1000).optional().describe("Maximum members to return (default 100)."),
      },
    },
    (async (p: { workspaceId?: string; query?: string; take?: number }) => {
      const workspaceId = ws(p.workspaceId);
      const data = await listMembers(workspaceId, p.query, p.take);
      return text({ workspaceId, memberCount: data.memberCount, members: data.members });
    }) as any,
  );

  server.registerTool(
    "get_doc_sharing",
    {
      title: "Get Document Sharing",
      description: "Show who can access a document: its public state, the default role for workspace members, and every user with an explicit role.",
      inputSchema: {
        workspaceId: z.string().optional(),
        docId: z.string().min(1),
      },
    },
    (async (p: { workspaceId?: string; docId: string }) => {
      const workspaceId = ws(p.workspaceId);
      const data = await gql.request<{ workspace: { doc: any } }>(
        `query DocSharing($id:String!,$docId:String!){ workspace(id:$id){ doc(docId:$docId){ public mode defaultRole grantedUsersList(pagination:{first:100}){ edges{ node{ role user{ id name email } } } } } } }`,
        { id: workspaceId, docId: p.docId },
      );
      const doc = data.workspace.doc;
      return text({
        workspaceId,
        docId: p.docId,
        public: doc.public,
        publicMode: doc.mode,
        defaultRole: doc.defaultRole,
        users: doc.grantedUsersList.edges.map((e: any) => ({ ...e.node.user, role: e.node.role })),
      });
    }) as any,
  );

  server.registerTool(
    "set_doc_user_role",
    {
      title: "Set Document User Role",
      description: "Give, change, or remove specific people's access to one document (Reader, Commenter, Editor, Manager, or remove). Users are workspace member ids or emails. Use get_doc_sharing to check the result.",
      inputSchema: {
        workspaceId: z.string().optional(),
        docId: z.string().min(1),
        users: z.array(z.string().min(1)).min(1).max(50).describe("Member user ids or emails."),
        role: z.enum([...DOC_ROLES, "remove"]).describe("Role to set, or 'remove' to revoke explicit access."),
      },
    },
    (async (p: { workspaceId?: string; docId: string; users: string[]; role: DocRole | "remove" }) => {
      const workspaceId = ws(p.workspaceId);
      const userIds = await resolveUserIds(workspaceId, p.users);
      if (p.role === "remove") {
        for (const userId of userIds) {
          await gql.request(`mutation Revoke($input:RevokeDocUserRoleInput!){ revokeDocUserRoles(input:$input) }`, { input: { workspaceId, docId: p.docId, userId } });
        }
      } else {
        const current = await gql.request<{ workspace: { doc: any } }>(
          `query Granted($id:String!,$docId:String!){ workspace(id:$id){ doc(docId:$docId){ grantedUsersList(pagination:{first:100}){ edges{ node{ user{ id } } } } } } }`,
          { id: workspaceId, docId: p.docId },
        );
        const granted = new Set(current.workspace.doc.grantedUsersList.edges.map((e: any) => e.node.user.id));
        const fresh = userIds.filter(id => !granted.has(id));
        if (fresh.length) {
          await gql.request(`mutation Grant($input:GrantDocUserRolesInput!){ grantDocUserRoles(input:$input) }`, { input: { workspaceId, docId: p.docId, userIds: fresh, role: p.role } });
        }
        for (const userId of userIds.filter(id => granted.has(id))) {
          await gql.request(`mutation Update($input:UpdateDocUserRoleInput!){ updateDocUserRole(input:$input) }`, { input: { workspaceId, docId: p.docId, userId, role: p.role } });
        }
      }
      return receipt("doc.share", { status: "applied", workspaceId, docId: p.docId, userIds, role: p.role });
    }) as any,
  );

  server.registerTool(
    "set_doc_default_role",
    {
      title: "Set Document Default Role",
      description: "Set the access every workspace member gets on a document unless they have an explicit role (None makes it private to explicitly shared people).",
      inputSchema: {
        workspaceId: z.string().optional(),
        docId: z.string().min(1),
        role: z.enum(["None", ...DOC_ROLES]),
      },
    },
    (async (p: { workspaceId?: string; docId: string; role: string }) => {
      const workspaceId = ws(p.workspaceId);
      await gql.request(`mutation Default($input:UpdateDocDefaultRoleInput!){ updateDocDefaultRole(input:$input) }`, { input: { workspaceId, docId: p.docId, role: p.role } });
      return receipt("doc.default_role", { status: "applied", workspaceId, docId: p.docId, role: p.role });
    }) as any,
  );

  server.registerTool(
    "invite_members",
    {
      title: "Invite Members",
      description: "Invite people to the workspace by email (AFFiNE sends the invitation email). Per-email errors are returned, e.g. when the server rate-limits invitations.",
      inputSchema: {
        workspaceId: z.string().optional(),
        emails: z.array(z.string().email()).min(1).max(50),
      },
    },
    (async (p: { workspaceId?: string; emails: string[] }) => {
      const workspaceId = ws(p.workspaceId);
      const data = await gql.request<{ inviteMembers: Array<{ email: string; inviteId: string | null; error: unknown }> }>(
        `mutation Invite($workspaceId:String!,$emails:[String!]!){ inviteMembers(workspaceId:$workspaceId, emails:$emails){ email inviteId error } }`,
        { workspaceId, emails: p.emails },
      );
      return receipt("workspace.invite", { status: "applied", workspaceId, results: data.inviteMembers });
    }) as any,
  );

  server.registerTool(
    "create_invite_link",
    {
      title: "Create Invite Link",
      description: "Create (or replace) the workspace invite link that anyone can use to request to join.",
      inputSchema: {
        workspaceId: z.string().optional(),
        expireTime: z.enum(["OneDay", "ThreeDays", "OneWeek", "OneMonth"]).optional().describe("Default OneWeek."),
      },
    },
    (async (p: { workspaceId?: string; expireTime?: string }) => {
      const workspaceId = ws(p.workspaceId);
      const data = await gql.request<{ createInviteLink: { link: string; expireTime: string } }>(
        `mutation Link($workspaceId:String!,$expireTime:WorkspaceInviteLinkExpireTime!){ createInviteLink(workspaceId:$workspaceId, expireTime:$expireTime){ link expireTime } }`,
        { workspaceId, expireTime: p.expireTime ?? "OneWeek" },
      );
      return receipt("workspace.invite_link", { status: "created", workspaceId, ...data.createInviteLink });
    }) as any,
  );
}
