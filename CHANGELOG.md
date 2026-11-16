# Changelog

## 0.1.1

- Catalog and schema docs are overviews instead of object lists, and schemas have their own one-line comments (vgi-lint 2.8: VGI173, VGI102).

## 0.1.0

Initial release: Jira Cloud (REST v3, enhanced JQL search) and Data Center (REST v2) issues
with SQL→JQL pushdown and fields= projection, changelog, comments, worklogs, links, projects,
components, versions, workflow statuses, boards, sprints, users and site metadata; custom
field hoisting via the `custom_fields` ATTACH option; Confluence Cloud spaces, CQL page
search with storage/plain-text bodies, page versions, labels and comments.

Targets: @query-farm/vgi 0.50 · VGI protocol 3.3 · Haybarn 2.0.0rc11 · vgi-lint-check 2.x (unpinned)
