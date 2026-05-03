def upgrade():
    op.add_column("users", sa.Column("nickname", sa.String(), nullable=True))


def downgrade():
    op.drop_column("users", "nickname")
