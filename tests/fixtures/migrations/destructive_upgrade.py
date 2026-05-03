"""Migration with destructive upgrade ops but a non-trivial downgrade."""

revision = "008"
down_revision = "007"


def upgrade():
    op.drop_column("widgets", "legacy_field")
    op.drop_table("legacy_widgets")


def downgrade():
    op.add_column("widgets", "legacy_field")
    op.create_table("legacy_widgets")
