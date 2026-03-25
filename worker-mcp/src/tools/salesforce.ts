import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface SalesforceConfig {
  instanceUrl: string;
  clientId: string;
  clientSecret: string;
}

// Cache the access token (refreshes on 401)
let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(config: SalesforceConfig): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.token;
  }

  const tokenUrl = `https://${config.instanceUrl}/services/oauth2/token`;
  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }).toString(),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Salesforce auth failed ${resp.status}: ${body}`);
  }

  const data: any = await resp.json();
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + 3500 * 1000, // ~1 hour minus buffer
  };
  return data.access_token;
}

async function sfFetch(config: SalesforceConfig, path: string, options?: RequestInit): Promise<any> {
  const token = await getAccessToken(config);
  const baseUrl = `https://${config.instanceUrl}`;
  const resp = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options?.headers || {}),
    },
  });

  if (resp.status === 401) {
    // Token expired — clear cache and retry once
    cachedToken = null;
    const newToken = await getAccessToken(config);
    const retry = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${newToken}`,
        "Content-Type": "application/json",
        ...(options?.headers || {}),
      },
    });
    if (!retry.ok) {
      const body = await retry.text();
      throw new Error(`Salesforce API ${retry.status}: ${body}`);
    }
    return retry.json();
  }

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Salesforce API ${resp.status}: ${body}`);
  }
  return resp.json();
}

export function registerSalesforceTools(server: McpServer, config: SalesforceConfig) {
  // -----------------------------------------------------------------------
  // SOQL Query
  // -----------------------------------------------------------------------
  server.registerTool(
    "sf_query",
    {
      title: "Query Salesforce",
      description:
        "Run a SOQL query against Salesforce. Use for searching accounts, contacts, opportunities, cases, leads, or any Salesforce object. Common objects: Account, Contact, Opportunity, Lead, Case.",
      inputSchema: {
        soql: z
          .string()
          .describe(
            'SOQL query. Examples: "SELECT Name, Industry FROM Account LIMIT 10", "SELECT Name, StageName, Amount FROM Opportunity WHERE StageName != \'Closed Won\'", "SELECT Name, Email FROM Contact WHERE AccountId = \'001....\'"'
          ),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ soql }) => {
      try {
        const data = await sfFetch(config, `/services/data/v60.0/query?q=${encodeURIComponent(soql)}`);
        const records = (data.records || []).map((r: any) => {
          const { attributes, ...fields } = r;
          return fields;
        });

        // Handle COUNT() queries — no records but totalSize has the answer
        if (records.length === 0 && data.totalSize > 0) {
          return { content: [{ type: "text" as const, text: `Count: ${data.totalSize}` }] };
        }

        if (records.length === 0) {
          return { content: [{ type: "text" as const, text: "No Salesforce records found." }] };
        }

        return {
          content: [{
            type: "text" as const,
            text: `${data.totalSize} record(s) found:\n${JSON.stringify(records, null, 2)}`,
          }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Salesforce query error: ${e.message}` }] };
      }
    }
  );

  // -----------------------------------------------------------------------
  // Search (SOSL - fuzzy text search)
  // -----------------------------------------------------------------------
  server.registerTool(
    "sf_search",
    {
      title: "Search Salesforce",
      description:
        "Fuzzy text search across Salesforce objects. Use when someone asks about a customer, deal, or contact by name. Searches across accounts, contacts, opportunities, leads, and cases.",
      inputSchema: {
        query: z
          .string()
          .describe("Search term — name, company, email, etc."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ query }) => {
      try {
        const sosl = `FIND {${query}} IN ALL FIELDS RETURNING Account(Name, Industry, Phone), Contact(Name, Email, Phone, Account.Name), Opportunity(Name, StageName, Amount, CloseDate), Lead(Name, Company, Email, Status)`;
        const data = await sfFetch(config, `/services/data/v60.0/search?q=${encodeURIComponent(sosl)}`);

        const results: any[] = [];
        for (const record of data.searchRecords || []) {
          const { attributes, ...fields } = record;
          results.push({ type: attributes.type, ...fields });
        }

        if (results.length === 0) {
          return { content: [{ type: "text" as const, text: `No Salesforce results for "${query}".` }] };
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Salesforce search error: ${e.message}` }] };
      }
    }
  );

  // -----------------------------------------------------------------------
  // Get record details
  // -----------------------------------------------------------------------
  server.registerTool(
    "sf_get_record",
    {
      title: "Get Salesforce Record",
      description:
        "Get full details of a specific Salesforce record by object type and ID.",
      inputSchema: {
        objectType: z.string().describe('Salesforce object type, e.g. "Account", "Contact", "Opportunity"'),
        recordId: z.string().describe("The Salesforce record ID"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ objectType, recordId }) => {
      try {
        const data = await sfFetch(config, `/services/data/v60.0/sobjects/${objectType}/${recordId}`);
        const { attributes, ...fields } = data;
        return {
          content: [{ type: "text" as const, text: JSON.stringify(fields, null, 2) }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Salesforce error: ${e.message}` }] };
      }
    }
  );

  // -----------------------------------------------------------------------
  // Create record
  // -----------------------------------------------------------------------
  server.registerTool(
    "sf_create_record",
    {
      title: "Create Salesforce Record",
      description:
        "Create a new record in Salesforce (Account, Contact, Opportunity, Lead, Case, etc).",
      inputSchema: {
        objectType: z.string().describe('Salesforce object type, e.g. "Account", "Contact", "Lead"'),
        fields: z
          .record(z.any())
          .describe('Field values as key-value pairs, e.g. {"Name": "Acme Corp", "Industry": "Technology"}'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ objectType, fields }) => {
      try {
        const data = await sfFetch(config, `/services/data/v60.0/sobjects/${objectType}`, {
          method: "POST",
          body: JSON.stringify(fields),
        });

        return {
          content: [{
            type: "text" as const,
            text: `${objectType} created! ID: ${data.id}`,
          }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Salesforce create error: ${e.message}` }] };
      }
    }
  );

  // -----------------------------------------------------------------------
  // Tooling API Query
  // -----------------------------------------------------------------------
  server.registerTool(
    "sf_tooling_query",
    {
      title: "Query Salesforce Tooling API",
      description:
        "Run a SOQL query against the Tooling API. Use for querying metadata like ApexClass, LightningComponentBundle, ApexTrigger, CustomObject, etc.",
      inputSchema: {
        soql: z
          .string()
          .describe(
            'Tooling SOQL query. Examples: "SELECT Id, Name FROM ApexClass LIMIT 10", "SELECT DeveloperName, MasterLabel FROM LightningComponentBundle"'
          ),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ soql }) => {
      try {
        const data = await sfFetch(config, `/services/data/v60.0/tooling/query?q=${encodeURIComponent(soql)}`);
        const records = (data.records || []).map((r: any) => {
          const { attributes, ...fields } = r;
          return fields;
        });
        if (records.length === 0) {
          return { content: [{ type: "text" as const, text: "No tooling records found." }] };
        }
        return {
          content: [{ type: "text" as const, text: `${data.totalSize} record(s):\n${JSON.stringify(records, null, 2)}` }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Tooling query error: ${e.message}` }] };
      }
    }
  );

  // -----------------------------------------------------------------------
  // Create Apex Class
  // -----------------------------------------------------------------------
  server.registerTool(
    "sf_create_apex",
    {
      title: "Create Apex Class",
      description:
        "Create an Apex class in the Salesforce org. Provide the full class body including 'public class MyClass { ... }'.",
      inputSchema: {
        name: z.string().describe("Class name, e.g. 'TeamBrainController'"),
        body: z.string().describe("Full Apex class body, e.g. 'public class TeamBrainController { ... }'"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ name, body }) => {
      try {
        const data = await sfFetch(config, `/services/data/v60.0/tooling/sobjects/ApexClass`, {
          method: "POST",
          body: JSON.stringify({ Name: name, Body: body, ApiVersion: 60.0 }),
        });
        return {
          content: [{ type: "text" as const, text: `Apex class "${name}" created! ID: ${data.id}` }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Apex create error: ${e.message}` }] };
      }
    }
  );

  // -----------------------------------------------------------------------
  // Create Lightning Web Component
  // -----------------------------------------------------------------------
  server.registerTool(
    "sf_create_lwc",
    {
      title: "Create Lightning Web Component",
      description:
        "Create a new LWC in the Salesforce org. Provide the component name, HTML template, JS controller, and optional XML metadata. The component will be deployed and available in the org.",
      inputSchema: {
        name: z.string().describe("Component name in camelCase, e.g. 'teamBrainWidget'"),
        html: z.string().describe("HTML template content (without <template> wrapper — it will be added)"),
        js: z.string().describe("JavaScript controller content (full ES module with import/export)"),
        xml: z.string().optional().describe("Optional: custom XML metadata. If omitted, defaults to apiVersion 60.0 exposed to appPage, recordPage, homePage."),
        description: z.string().optional().describe("Component description"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ name, html, js, xml, description }) => {
      try {
        const defaultXml = `<?xml version="1.0" encoding="UTF-8"?>
<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>60.0</apiVersion>
    <isExposed>true</isExposed>
    <description>${description || name}</description>
    <targets>
        <target>lightning__AppPage</target>
        <target>lightning__RecordPage</target>
        <target>lightning__HomePage</target>
    </targets>
</LightningComponentBundle>`;

        const htmlContent = html.trim().startsWith("<template>") ? html : `<template>\n${html}\n</template>`;

        // Create the bundle with all source files
        const bundlePayload = {
          MasterLabel: name,
          DeveloperName: name,
          Description: description || `LWC: ${name}`,
          ApiVersion: 60.0,
          LightningResources: [
            {
              FilePath: `${name}/${name}.html`,
              Source: htmlContent,
              Format: "html",
            },
            {
              FilePath: `${name}/${name}.js`,
              Source: js,
              Format: "js",
            },
            {
              FilePath: `${name}/${name}.js-meta.xml`,
              Source: xml || defaultXml,
              Format: "xml",
            },
          ],
        };

        const data = await sfFetch(config, `/services/data/v60.0/tooling/sobjects/LightningComponentBundle`, {
          method: "POST",
          body: JSON.stringify(bundlePayload),
        });

        return {
          content: [{
            type: "text" as const,
            text: `LWC "${name}" created and deployed! ID: ${data.id}\nYou can now add it to any Lightning page in the org.`,
          }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `LWC create error: ${e.message}` }] };
      }
    }
  );

  // -----------------------------------------------------------------------
  // Generic Tooling API Create (any metadata type)
  // -----------------------------------------------------------------------
  server.registerTool(
    "sf_tooling_create",
    {
      title: "Create Salesforce Metadata (Tooling API)",
      description:
        "Create ANY metadata component via the Tooling API. Supports: ApexClass, ApexTrigger, ApexPage, ApexComponent, LightningComponentBundle, CustomObject, CustomField, ValidationRule, FlexiPage, PermissionSet, StaticResource, AuraDefinitionBundle, and more. Provide the Tooling API sObject type and the field values.",
      inputSchema: {
        toolingType: z.string().describe('Tooling API sObject type, e.g. "CustomObject", "CustomField", "FlexiPage", "ValidationRule", "ApexTrigger", "StaticResource"'),
        fields: z.record(z.any()).describe("Field values as key-value pairs. Check Salesforce Tooling API docs for required fields per type."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ toolingType, fields }) => {
      try {
        const data = await sfFetch(config, `/services/data/v60.0/tooling/sobjects/${toolingType}`, {
          method: "POST",
          body: JSON.stringify(fields),
        });
        return {
          content: [{ type: "text" as const, text: `${toolingType} created! ID: ${data.id}` }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Tooling create error: ${e.message}` }] };
      }
    }
  );

  // -----------------------------------------------------------------------
  // Generic Tooling API Update
  // -----------------------------------------------------------------------
  server.registerTool(
    "sf_tooling_update",
    {
      title: "Update Salesforce Metadata (Tooling API)",
      description:
        "Update any existing metadata component via the Tooling API. Provide the sObject type, record ID, and fields to update.",
      inputSchema: {
        toolingType: z.string().describe("Tooling API sObject type"),
        recordId: z.string().describe("The record ID to update"),
        fields: z.record(z.any()).describe("Fields to update"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ toolingType, recordId, fields }) => {
      try {
        const token = await getAccessToken(config);
        const baseUrl = `https://${config.instanceUrl}`;
        const resp = await fetch(`${baseUrl}/services/data/v60.0/tooling/sobjects/${toolingType}/${recordId}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(fields),
        });
        if (resp.status === 204) {
          return { content: [{ type: "text" as const, text: `${toolingType} ${recordId} updated successfully.` }] };
        }
        if (!resp.ok) {
          const body = await resp.text();
          throw new Error(`${resp.status}: ${body}`);
        }
        return { content: [{ type: "text" as const, text: `${toolingType} ${recordId} updated.` }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Tooling update error: ${e.message}` }] };
      }
    }
  );

  // -----------------------------------------------------------------------
  // Generic Tooling API Delete
  // -----------------------------------------------------------------------
  server.registerTool(
    "sf_tooling_delete",
    {
      title: "Delete Salesforce Metadata (Tooling API)",
      description:
        "Delete a metadata component via the Tooling API.",
      inputSchema: {
        toolingType: z.string().describe("Tooling API sObject type"),
        recordId: z.string().describe("The record ID to delete"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ toolingType, recordId }) => {
      try {
        const token = await getAccessToken(config);
        const baseUrl = `https://${config.instanceUrl}`;
        const resp = await fetch(`${baseUrl}/services/data/v60.0/tooling/sobjects/${toolingType}/${recordId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        });
        if (resp.status === 204) {
          return { content: [{ type: "text" as const, text: `${toolingType} ${recordId} deleted.` }] };
        }
        if (!resp.ok) {
          const body = await resp.text();
          throw new Error(`${resp.status}: ${body}`);
        }
        return { content: [{ type: "text" as const, text: `${toolingType} ${recordId} deleted.` }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Tooling delete error: ${e.message}` }] };
      }
    }
  );

  // -----------------------------------------------------------------------
  // Create Custom Object (high-level)
  // -----------------------------------------------------------------------
  server.registerTool(
    "sf_create_custom_object",
    {
      title: "Create Custom Object",
      description:
        "Create a custom object in Salesforce with optional custom fields. The object gets a standard Name field automatically.",
      inputSchema: {
        objectName: z.string().describe("Object name without __c suffix, e.g. 'Innovation_Project'"),
        label: z.string().describe("Display label, e.g. 'Innovation Project'"),
        pluralLabel: z.string().describe("Plural label, e.g. 'Innovation Projects'"),
        description: z.string().optional().describe("Object description"),
        nameFieldType: z.enum(["Text", "AutoNumber"]).optional().describe("Name field type (default: Text)"),
        nameFieldLabel: z.string().optional().describe("Name field label (default: object label + ' Name')"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ objectName, label, pluralLabel, description, nameFieldType, nameFieldLabel }) => {
      try {
        const fullName = objectName.endsWith("__c") ? objectName : `${objectName}__c`;
        const payload: any = {
          FullName: fullName,
          Metadata: {
            label,
            pluralLabel,
            description: description || "",
            nameField: {
              type: nameFieldType || "Text",
              label: nameFieldLabel || `${label} Name`,
            },
            deploymentStatus: "Deployed",
            sharingModel: "ReadWrite",
          },
        };
        const data = await sfFetch(config, `/services/data/v60.0/tooling/sobjects/CustomObject`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        return {
          content: [{ type: "text" as const, text: `Custom object "${fullName}" created! ID: ${data.id}\nLabel: ${label} / ${pluralLabel}` }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Custom object error: ${e.message}` }] };
      }
    }
  );

  // -----------------------------------------------------------------------
  // Create Custom Field
  // -----------------------------------------------------------------------
  server.registerTool(
    "sf_create_custom_field",
    {
      title: "Create Custom Field",
      description:
        "Add a custom field to a standard or custom object. Supports Text, Number, Currency, Date, DateTime, Checkbox, Picklist, LongTextArea, Email, Phone, Url, Lookup, and more.",
      inputSchema: {
        objectName: z.string().describe("Object API name, e.g. 'Account' or 'Innovation_Project__c'"),
        fieldName: z.string().describe("Field name without __c suffix, e.g. 'Budget'"),
        label: z.string().describe("Field label, e.g. 'Budget Amount'"),
        type: z.string().describe("Field type: Text, Number, Currency, Date, DateTime, Checkbox, Picklist, LongTextArea, Email, Phone, Url, Lookup, Percent, TextArea"),
        length: z.number().optional().describe("For Text fields — max length (default 255)"),
        precision: z.number().optional().describe("For Number/Currency — total digits (default 18)"),
        scale: z.number().optional().describe("For Number/Currency — decimal places (default 2)"),
        picklistValues: z.array(z.string()).optional().describe("For Picklist — list of values"),
        referenceTo: z.string().optional().describe("For Lookup — target object API name"),
        required: z.boolean().optional().describe("Whether the field is required (default false)"),
        description: z.string().optional().describe("Field description"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ objectName, fieldName, label, type, length, precision, scale, picklistValues, referenceTo, required, description }) => {
      try {
        const fullFieldName = fieldName.endsWith("__c") ? fieldName : `${fieldName}__c`;
        const fullName = `${objectName}.${fullFieldName}`;

        const metadata: any = {
          label,
          type,
          description: description || "",
          required: required || false,
        };

        // Type-specific config
        if (type === "Text") metadata.length = length || 255;
        if (type === "LongTextArea" || type === "TextArea") {
          metadata.length = length || 32768;
          metadata.visibleLines = 5;
        }
        if (type === "Number" || type === "Currency" || type === "Percent") {
          metadata.precision = precision || 18;
          metadata.scale = scale || 2;
        }
        if (type === "Picklist" && picklistValues) {
          metadata.valueSet = {
            valueSetDefinition: {
              value: picklistValues.map((v) => ({ fullName: v, label: v, default: false })),
              sorted: false,
            },
          };
        }
        if (type === "Lookup" && referenceTo) {
          metadata.referenceTo = referenceTo;
          metadata.relationshipName = fieldName.replace(/__c$/, "").replace(/_/g, "");
          metadata.relationshipLabel = label;
        }
        if (type === "Checkbox") {
          metadata.defaultValue = false;
        }

        const data = await sfFetch(config, `/services/data/v60.0/tooling/sobjects/CustomField`, {
          method: "POST",
          body: JSON.stringify({ FullName: fullName, Metadata: metadata }),
        });

        return {
          content: [{ type: "text" as const, text: `Field "${fullFieldName}" added to ${objectName}! ID: ${data.id}\nType: ${type}, Label: ${label}` }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Custom field error: ${e.message}` }] };
      }
    }
  );

  // -----------------------------------------------------------------------
  // Describe Object (see fields, relationships)
  // -----------------------------------------------------------------------
  server.registerTool(
    "sf_describe_object",
    {
      title: "Describe Salesforce Object",
      description:
        "Get the schema for any Salesforce object — all fields, types, relationships, picklist values. Use to understand an object's structure before creating records or adding fields.",
      inputSchema: {
        objectName: z.string().describe("Object API name, e.g. 'Account', 'Innovation_Project__c'"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ objectName }) => {
      try {
        const data = await sfFetch(config, `/services/data/v60.0/sobjects/${objectName}/describe`);
        const fields = (data.fields || []).map((f: any) => ({
          name: f.name,
          label: f.label,
          type: f.type,
          required: !f.nillable && !f.defaultedOnCreate,
          custom: f.custom,
          ...(f.picklistValues?.length > 0 ? { picklistValues: f.picklistValues.map((p: any) => p.value) } : {}),
          ...(f.referenceTo?.length > 0 ? { referenceTo: f.referenceTo } : {}),
        }));
        return {
          content: [{
            type: "text" as const,
            text: `${objectName} — ${fields.length} fields:\n${JSON.stringify(fields, null, 2)}`,
          }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Describe error: ${e.message}` }] };
      }
    }
  );

  // -----------------------------------------------------------------------
  // Metadata API CRUD (for FlexiPages, Layouts, etc.)
  // -----------------------------------------------------------------------
  server.registerTool(
    "sf_metadata_read",
    {
      title: "Read Salesforce Metadata",
      description:
        "Read metadata components via the Metadata API REST endpoint. Supports: CustomObject, Layout, FlexiPage, Profile, PermissionSet, Flow, ApexClass, ApexTrigger, LightningComponentBundle, CustomTab, CustomApplication, and more.",
      inputSchema: {
        metadataType: z.string().describe('Metadata type, e.g. "Layout", "FlexiPage", "CustomTab"'),
        fullNames: z.array(z.string()).describe('Full names to read, e.g. ["Account-Account Layout"]'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ metadataType, fullNames }) => {
      try {
        const data = await sfFetch(config, `/services/data/v60.0/tooling/sobjects/${metadataType}/${fullNames[0]}`);
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch {
        // Fallback: use composite metadata read
        try {
          const token = await getAccessToken(config);
          const baseUrl = `https://${config.instanceUrl}`;
          const resp = await fetch(`${baseUrl}/services/data/v60.0/tooling/query?q=${encodeURIComponent(`SELECT Id, FullName, Metadata FROM ${metadataType} WHERE FullName IN ('${fullNames.join("','")}')`)}`, {
            headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          });
          const result = await resp.json() as any;
          const records = (result.records || []).map((r: any) => {
            const { attributes, ...fields } = r;
            return fields;
          });
          return { content: [{ type: "text" as const, text: JSON.stringify(records, null, 2) }] };
        } catch (e2: any) {
          return { content: [{ type: "text" as const, text: `Metadata read error: ${e2.message}` }] };
        }
      }
    }
  );

  // -----------------------------------------------------------------------
  // Create Validation Rule
  // -----------------------------------------------------------------------
  server.registerTool(
    "sf_create_validation_rule",
    {
      title: "Create Validation Rule",
      description:
        "Create a validation rule on a Salesforce object.",
      inputSchema: {
        objectName: z.string().describe("Object API name, e.g. 'Account' or 'Innovation_Project__c'"),
        ruleName: z.string().describe("Rule API name, e.g. 'Require_Budget'"),
        errorConditionFormula: z.string().describe("Formula that evaluates to TRUE when the rule should fire, e.g. 'ISBLANK(Budget__c)'"),
        errorMessage: z.string().describe("Error message shown to the user"),
        active: z.boolean().optional().describe("Whether the rule is active (default true)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ objectName, ruleName, errorConditionFormula, errorMessage, active }) => {
      try {
        const data = await sfFetch(config, `/services/data/v60.0/tooling/sobjects/ValidationRule`, {
          method: "POST",
          body: JSON.stringify({
            FullName: `${objectName}.${ruleName}`,
            Metadata: {
              errorConditionFormula,
              errorMessage,
              active: active !== false,
            },
          }),
        });
        return {
          content: [{ type: "text" as const, text: `Validation rule "${ruleName}" created on ${objectName}! ID: ${data.id}` }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Validation rule error: ${e.message}` }] };
      }
    }
  );

  // -----------------------------------------------------------------------
  // Execute Anonymous Apex
  // -----------------------------------------------------------------------
  server.registerTool(
    "sf_execute_anonymous",
    {
      title: "Execute Anonymous Apex",
      description:
        "Run anonymous Apex code in the Salesforce org. Use for one-off scripts, data fixes, testing logic, inserting/updating/deleting records programmatically, or running any Apex code on the fly. Returns compilation and execution status plus debug log output.",
      inputSchema: {
        code: z.string().describe("Apex code to execute. Example: 'System.debug(\\\"Hello World\\\");' or 'insert new Account(Name=\\\"Test\\\");'"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ code }) => {
      try {
        const data = await sfFetch(config, `/services/data/v60.0/tooling/executeAnonymous?anonymousBody=${encodeURIComponent(code)}`);

        let result = "";
        if (!data.compiled) {
          result = `Compilation Error (line ${data.line}, col ${data.column}):\n${data.compileProblem}`;
        } else if (!data.success) {
          result = `Runtime Error:\n${data.exceptionMessage}\n${data.exceptionStackTrace || ""}`;
        } else {
          result = "Executed successfully!";
        }

        if (data.debugLog) {
          // Extract USER_DEBUG lines from the log
          const debugLines = data.debugLog
            .split("\n")
            .filter((l: string) => l.includes("USER_DEBUG") || l.includes("EXCEPTION"))
            .map((l: string) => l.replace(/.*\|USER_DEBUG\|.*\|DEBUG\|/, "").trim())
            .filter((l: string) => l);
          if (debugLines.length > 0) {
            result += `\n\nDebug output:\n${debugLines.join("\n")}`;
          }
        }

        return { content: [{ type: "text" as const, text: result }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Execute anonymous error: ${e.message}` }] };
      }
    }
  );

  // -----------------------------------------------------------------------
  // List metadata (describe what's in the org)
  // -----------------------------------------------------------------------
  server.registerTool(
    "sf_describe_metadata",
    {
      title: "Describe Salesforce Metadata",
      description:
        "List metadata components in the org — Apex classes, LWCs, triggers, custom objects, etc. Use to see what's deployed.",
      inputSchema: {
        metadataType: z
          .enum(["ApexClass", "ApexTrigger", "LightningComponentBundle", "CustomObject", "FlexiPage", "Flow"])
          .describe("The metadata type to list"),
        limit: z.number().optional().describe("Max results (default 20)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ metadataType, limit }) => {
      try {
        const max = limit || 20;
        let soql: string;
        switch (metadataType) {
          case "ApexClass":
            soql = `SELECT Id, Name, CreatedDate, LastModifiedDate FROM ApexClass ORDER BY LastModifiedDate DESC LIMIT ${max}`;
            break;
          case "ApexTrigger":
            soql = `SELECT Id, Name, TableEnumOrId, CreatedDate FROM ApexTrigger ORDER BY CreatedDate DESC LIMIT ${max}`;
            break;
          case "LightningComponentBundle":
            soql = `SELECT Id, DeveloperName, MasterLabel, Description, CreatedDate FROM LightningComponentBundle ORDER BY CreatedDate DESC LIMIT ${max}`;
            break;
          case "CustomObject":
            soql = `SELECT Id, DeveloperName, Description FROM CustomObject ORDER BY DeveloperName LIMIT ${max}`;
            break;
          case "FlexiPage":
            soql = `SELECT Id, DeveloperName, MasterLabel FROM FlexiPage ORDER BY DeveloperName LIMIT ${max}`;
            break;
          case "Flow":
            soql = `SELECT Id, DefinitionId, MasterLabel, Status FROM Flow ORDER BY MasterLabel LIMIT ${max}`;
            break;
          default:
            return { content: [{ type: "text" as const, text: `Unknown metadata type: ${metadataType}` }] };
        }
        const data = await sfFetch(config, `/services/data/v60.0/tooling/query?q=${encodeURIComponent(soql)}`);
        const records = (data.records || []).map((r: any) => {
          const { attributes, ...fields } = r;
          return fields;
        });
        return {
          content: [{
            type: "text" as const,
            text: records.length === 0
              ? `No ${metadataType} found.`
              : `${data.totalSize} ${metadataType}(s):\n${JSON.stringify(records, null, 2)}`,
          }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Metadata describe error: ${e.message}` }] };
      }
    }
  );
}
